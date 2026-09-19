#!/usr/bin/env node
/**
 * WE 音频可视化的离线校验（不依赖浏览器 / WebGL / 音频设备）。
 *
 * 覆盖四条链路：
 *   1. 模拟频谱流（render/audio.js）：确定性、取值域、静音段、节拍结构、降采样一致；
 *   2. audioResponse（pulse.vert CreateAudioResponse 的 CPU 镜像）逐公式复算；
 *   3. 文字脚本沙箱 engine.registerAudioBuffers（text.js）+ 视图填充联动；
 *   4. 粒子 audioprocessingmode 发射量门控（particles.js，合成模型不含库数据）；
 *   5. 真实壁纸 shader 转译冒烟：从本机库抽取 pulse / Simple_Audio_Bars，
 *      用 headers.ts 的公共头转译成 GLSL ES 3.0，做结构断言（音频 uniform 数组、
 *      ApplyBlending 内联、预处理残留、括号平衡）。
 *
 * 用法：node scripts/verify-audio.mjs   （退出码非 0 表示发现问题，可用于 CI）
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker } from "./lib/verify-kit.mjs";
const { createSimulatedAudio, audioResponse, fillAudioBuffers } = await imp(
  "renderer/vendor/we-scene/render/audio.js",
);
const { evalTextScript, evalObjectScript } = await imp("renderer/vendor/we-scene/render/text.js");
const { ParticleSystem } = await imp("renderer/vendor/we-scene/render/particles.js");
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { hlsl2glsl } = await imp("renderer/vendor/we-scene/render/hlsl2glsl.js");

const { check, errors } = createChecker();

// ---------- 1. 模拟频谱流 ----------
{
  const sim = createSimulatedAudio(1);
  let maxLevel = 0;
  let playingLevelSum = 0;
  let playingN = 0;
  let silentMax = 0;
  let beatBassSum = 0;
  let beatBassN = 0;
  let offBassSum = 0;
  let offBassN = 0;
  const BEAT = 60 / 112;
  for (let i = 0; i < 60 * 60; i++) {
    const t = i / 60;
    const s = sim.update(t);
    const section = t % 32;
    for (const arr of [s.left64, s.right64, s.left32, s.right32, s.left16, s.right16]) {
      for (const v of arr) {
        check(Number.isFinite(v), `t=${t}: 频谱出现非有限值`);
        check(v >= 0 && v <= 1, `t=${t}: 频谱值越界 ${v}`);
      }
    }
    check(Number.isFinite(s.level) && s.level >= 0 && s.level <= 1, `t=${t}: level 越界 ${s.level}`);
    maxLevel = Math.max(maxLevel, s.level);
    if (section < 24) {
      playingLevelSum += s.level;
      playingN++;
      // 底鼓节拍结构：拍点窗口（打击包络峰值处）低频均值显著高于拍间中段
      const beatPhase = (t % BEAT) / BEAT;
      if (beatPhase < 0.1) {
        beatBassSum += s.left64[1];
        beatBassN++;
      } else if (beatPhase > 0.55 && beatPhase < 0.7) {
        offBassSum += s.left64[1];
        offBassN++;
      }
    }
    if (section >= 27.5 && section < 28.5) {
      silentMax = Math.max(silentMax, s.level);
    }
  }
  const beatBass = beatBassSum / beatBassN;
  const offBass = offBassSum / offBassN;
  check(maxLevel > 0.3, `播放段整体响度过低 max=${maxLevel}`);
  check(playingLevelSum / playingN > 0.08, `播放段平均响度过低 avg=${playingLevelSum / playingN}`);
  check(silentMax < 0.05, `静音段响度过高 max=${silentMax}`);
  check(beatBass > offBass * 1.5, `节拍结构不成立 beat=${beatBass.toFixed(3)} off=${offBass.toFixed(3)}`);

  // 真立体声：左右声道**内容**去相关（底鼓居中、军鼓偏左、踩镲偏右、和弦左右
  // 独立游走），不是同一波形乘 (1±pan) 的伪立体声 —— 旧实现左右条完全同相，
  // 双声道可视化看着是镜像单声道（用户实测要求改）。同时左右能量必须保持平衡
  // （GAIN=3.2 按双声道总和标定的场景音条不能歪）。
  {
    const simS = createSimulatedAudio(7);
    let sumAbsDiff = 0;
    let sumL = 0;
    let sumR = 0;
    let n = 0;
    for (let f = 0; f < 1200; f++) {
      const s = simS.update(1 + f / 60); // 跳过开头，取稳定播放段
      for (let i = 0; i < 64; i++) {
        sumAbsDiff += Math.abs(s.left64[i] - s.right64[i]);
        sumL += s.left64[i];
        sumR += s.right64[i];
        n++;
      }
    }
    const meanDiff = sumAbsDiff / n;
    check(meanDiff > 0.05, `立体声去相关不足：L/R 平均绝对差 ${meanDiff.toFixed(4)}（伪立体声 ≈0.02，应 >0.05）`);
    check(meanDiff < 0.45, `立体声分离过度：L/R 平均绝对差 ${meanDiff.toFixed(4)}（应 <0.45，否则左右完全不像一首歌）`);
    const ratio = sumL / Math.max(1e-9, sumR);
    check(ratio > 0.85 && ratio < 1.15, `左右能量失衡：L/R=${ratio.toFixed(3)}（应 0.85~1.15）`);
    // pre 系列同样要立体声（网页 gamma 扩展驱动的是 preL64/preR64）
    const s2 = createSimulatedAudio(7).update(5.5);
    let preDiff = 0;
    for (let i = 0; i < 64; i++) preDiff += Math.abs(s2.preL64[i] - s2.preR64[i]);
    check(preDiff / 64 > 0.01, `preL64/preR64 去相关不足：${(preDiff / 64).toFixed(4)}`);
  }

  // 确定性：同 t 重复调用结果一致（暂停/回卷安全）
  const a = createSimulatedAudio(1).update(7.77);
  const b = createSimulatedAudio(1).update(7.77);
  for (let i = 0; i < 64; i++) {
    if (a.left64[i] !== b.left64[i]) {
      errors.push(`确定性破坏 @band ${i}: ${a.left64[i]} != ${b.left64[i]}`);
      break;
    }
  }

  // 降采样一致性：分组均值不改变频段均值
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const s2 = createSimulatedAudio(2).update(11.2);
  check(Math.abs(mean(s2.left64) - mean(s2.left32)) < 1e-6, "64→32 降采样均值漂移");
  check(Math.abs(mean(s2.left64) - mean(s2.left16)) < 1e-6, "64→16 降采样均值漂移");

  // [we-scene patch] 负时间必须全部有限：首帧 rAF 时间戳可以早于挂载时刻的
  // performance.now()（vsync 对齐），t=(now-start)/1000 ≈ -0.005。
  // `Math.floor(step) % 16` 得 -1 → patterns[i16<0] = undefined → 64 频段全 NaN
  // 灌进共享音频视图；3233141951 反光层的缩放脚本把 NaN 积分进 smoothValue
  // （作者脚本无自愈），整层永久塌成 scale=[0,0,1] 隐形。
  {
    const simNeg = createSimulatedAudio(3);
    for (const t of [-2, -1.2, -0.5, -0.05, -0.02, -0.005, -0.001, -1 / 60000]) {
      const s = simNeg.update(t);
      for (const arr of [s.left64, s.right64, s.left32, s.right32, s.left16, s.right16, s.preL64, s.preR64]) {
        for (const v of arr) check(Number.isFinite(v), `负时间 t=${t}: 频谱出现非有限值 ${v}`);
      }
      check(Number.isFinite(s.level), `负时间 t=${t}: level 非有限`);
    }
    // 接线断言：帧循环的场景时间必须钳非负（负 t 对一切下游无意义）
    const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    check(
      /const t = Math\.max\(0, \(now - start - pauseAccum\) \/ 1000\)/.test(mountSrc),
      "帧循环的场景时间必须钳非负（首帧 rAF 时间戳可早于挂载时刻）",
    );
  }
}

// ---------- 2. audioResponse：与 pulse.vert CreateAudioResponse 逐公式对照 ----------
{
  const bands = { left: new Float32Array(16), right: new Float32Array(16) };
  for (let i = 0; i < 16; i++) {
    bands.left[i] = i / 32; // 0, 1/32, ..., 15/32
    bands.right[i] = 1 - i / 32;
  }
  // mode=3：[min,max] 平均 → smoothstep(bounds) → pow(power) × amount
  const v = audioResponse(bands, 3, 0, 7, [0.2, 0.6], 2, 1.5);
  let sum = 0;
  for (let i = 0; i <= 7; i++) sum += (bands.left[i] + bands.right[i]) * 0.5;
  let expect = sum / 8;
  {
    const k = Math.min(1, Math.max(0, (expect - 0.2) / (0.6 - 0.2)));
    expect = k * k * (3 - 2 * k);
    expect = Math.min(1, Math.max(0, Math.pow(expect, 2))) * 1.5;
  }
  check(Math.abs(v - expect) < 1e-9, `audioResponse 与 shader 公式不一致 ${v} != ${expect}`);
  check(audioResponse(bands, 0, 0, 15, [0, 1], 1, 1) === 0, "mode=0 应返回 0");
  const vl = audioResponse(bands, 1, 0, 0, [0, 1], 1, 1);
  const vr = audioResponse(bands, 2, 0, 0, [0, 1], 1, 1);
  check(Math.abs(vl - bands.left[0]) < 1e-9 && Math.abs(vr - bands.right[0]) < 1e-9, "mode=1/2 声道选错");
}

// ---------- 3. 文字脚本沙箱 registerAudioBuffers ----------
{
  const script = `
'use strict';
let audioBuffer = engine.registerAudioBuffers(16);
export function update(value) {
    return 'bass=' + Math.round(audioBuffer.average[0] * 100);
}
`;
  const views = new Map();
  const sb = evalTextScript(script, {}, { audioViews: views });
  check(sb !== null, "含 registerAudioBuffers 的脚本求值失败");
  if (sb) {
    check(views.has(16), "registerAudioBuffers(16) 未注册视图");
    // 未填充时全 0
    const r0 = sb.callUpdate("");
    check(r0 === "bass=0", `静音时脚本文本错误: ${r0}`);
    // 填充后读到最新值（n=16 视图 = 64 band 按 4 个一组求均值）
    const sim = createSimulatedAudio(3);
    const snap = sim.update(5.5);
    fillAudioBuffers(views, snap);
    const gmean = (arr, i) => (arr[i * 4] + arr[i * 4 + 1] + arr[i * 4 + 2] + arr[i * 4 + 3]) / 4;
    const expect = Math.round(((gmean(snap.left64, 0) + gmean(snap.right64, 0)) / 2) * 100);
    const r1 = sb.callUpdate(r0);
    check(r1 === `bass=${expect}`, `视图填充后脚本文本错误: ${r1} != bass=${expect}`);
    // 同 n 共享一份；任意 n（如 32/64）可注册；越界 n 收敛到 64
    const v16 = views.get(16);
    sb.engine.registerAudioBuffers(16);
    check(views.get(16) === v16, "同 n 未共享视图");
    sb.engine.registerAudioBuffers(64);
    check(views.has(64), "n=64 未注册");
    sb.engine.registerAudioBuffers(99);
    check(views.has(64), "n>64 未收敛到 64");
  }
  // 无宿主音频（缺 audioViews）：返回全零数组且不抛错（与 WE 静音一致）
  const sb2 = evalTextScript(script, {}, {});
  if (sb2) check(sb2.callUpdate("") === "bass=0", "无音频宿主下脚本文本应为 bass=0");
}

// ---------- 4. 粒子 audioprocessingmode ----------
{
  // 合成模型：音频驱动 rate 发射器 + 音频常驻场（无 rate），都带 "0.5 1" 门槛
  const mk = () => ({
    maxcount: 100,
    emitter: [
      { name: "sphererandom", rate: 40, audioprocessingmode: 3, audioprocessingbounds: "0.5 1", distancemin: 1, distancemax: 2 },
      { name: "sphererandom", audioprocessingmode: 3, audioprocessingbounds: "0.5 1", distancemin: 1, distancemax: 2 },
    ],
    initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
    operator: [],
    renderer: [{ name: "billboard" }],
  });
  const glStub = null; // 只跑模拟，不渲染（setTexture 前不会碰 GL）
  const live = (ps) => ps.pool.reduce((s, p) => s + (p.alive ? 1 : 0), 0);

  const silent = new ParticleSystem(glStub, mk(), null, {});
  for (let i = 0; i < 120; i++) silent.advance(1 / 60, null); // 无音频 = 静音
  check(live(silent) === 0, `静音时音频粒子应不发射，实发 ${live(silent)}`);

  const loud = new ParticleSystem(glStub, mk(), null, {});
  for (let i = 0; i < 120; i++) loud.advance(1 / 60, { level: 0.9 }); // 响度 0.9 过 "0.5 1" 门槛
  check(live(loud) > 30, `响度 0.9 时发射过少：${live(loud)}`);

  const soft = new ParticleSystem(glStub, mk(), null, {});
  for (let i = 0; i < 120; i++) soft.advance(1 / 60, { level: 0.45 }); // 低于 bounds 下限
  check(live(soft) === 0, `响度 0.45 未过门槛不应发射：${live(soft)}`);

  // 常驻场：目标池量 ∝ 响度（lifetime 10s；只跑到 5s，避开首批粒子 10s 同时死亡的低谷）
  const steady = new ParticleSystem(glStub, mk(), null, {});
  for (let i = 0; i < 300; i++) steady.advance(1 / 60, { level: 0.9 });
  const full = live(steady);
  check(full > 60, `音频常驻场池量过低：${full}`);
  const quiet = new ParticleSystem(glStub, mk(), null, {});
  for (let i = 0; i < 300; i++) quiet.advance(1 / 60, { level: 0 });
  check(live(quiet) === 0, "响度 0 常驻场应为空");
  void full;
}

// ---------- 4b. 发射器音频参数：mode/频段/bounds/exponent（3669623379 光束）----------
// 缺陷：emitter 的 audioprocessingmode/frequencystart/end 此前被解析但门控只用整体
// level（audioGate(bounds, level)），省略的 bounds 默认成 (0,1)，频段与 exponent 全丢。
// 3669623379 的 light_shafts_0 指定 mode=3、freq 1..15（剔除底鼓 band0）、省略 bounds
// 与 exponent，官方 ObjectParser.cpp 默认 bounds=(0.8,1.0)、exponent=2。旧实现里光束
// 被底鼓电平推着常发（实机 live 恒 4/40、~0.3/s），真实音乐（中高频驱动）反而错。
{
  const snap = (b) => ({
    level: 1,
    left16: new Float32Array(16).map((_, i) => (b(i) ? 0.95 : 0)),
    right16: new Float32Array(16).map((_, i) => (b(i) ? 0.95 : 0)),
  });
  const run = (emitter, audio, frames = 600) => {
    const model = {
      maxcount: 200,
      emitter: [emitter],
      initializer: [{ name: "lifetimerandom", min: 10, max: 10 }],
      operator: [],
      renderer: [{ name: "billboard" }],
    };
    const ps = new ParticleSystem(null, model, null, {});
    for (let i = 0; i < frames; i++) ps.advance(1 / 60, audio);
    return ps.pool.reduce((s, p) => s + (p.alive ? 1 : 0), 0);
  };
  const liveCount = (x) => x;

  // 3669 光束配置（来自真实 light_shafts_0.json）
  const beamEmitter = {
    name: "sphererandom", rate: 40,
    audioprocessingmode: 3, audioprocessingfrequencystart: 1, audioprocessingfrequencyend: 15,
    distancemin: 0, distancemax: 0,
  };
  const probe = new ParticleSystem(null, {
    maxcount: 1, emitter: [beamEmitter], initializer: [], operator: [], renderer: [{ name: "billboard" }],
  }, null, {});
  const ce = probe.emitters[0];
  check(ce.audioMode === 3, `光束 mode 应为 3，实得 ${ce.audioMode}`);
  check(ce.audioFreqStart === 1 && ce.audioFreqEnd === 15, `光束频段应为 1..15，实得 ${ce.audioFreqStart}..${ce.audioFreqEnd}`);
  check(ce.audioBounds[0] === 0.8 && ce.audioBounds[1] === 1.0,
    `省略 bounds 的 emitter 默认应为 (0.8,1)（官方 ObjectParser），实得 (${ce.audioBounds})`);
  check(ce.audioExponent === 2, `省略 exponent 的 emitter 默认应为 2（官方 ObjectParser），实得 ${ce.audioExponent}`);

  // 频段选择：只在 band0（底鼓）满幅、band1..15 全静时，门控必须为 0（旧实现会因 level 高而常发）
  check(liveCount(run(beamEmitter, snap((i) => i === 0))) === 0, "光束 freq=1..15：只有底鼓 band0 时不应发射");
  // band1..15 满幅时应大量发射
  check(liveCount(run(beamEmitter, snap((i) => i >= 1 && i <= 15))) > 100, "光束 band1..15 满幅时应大量发射");
  // 静音不发
  check(liveCount(run(beamEmitter, snap(() => false))) === 0, "光束全静时不应发射");

  // 作者显式窄频带（2857410102 starfield：freq 15..15）必须只看那一个 band
  const narrow = { name: "sphererandom", rate: 100, audioprocessingmode: 3,
    audioprocessingfrequencystart: 15, audioprocessingfrequencyend: 15,
    audioprocessingbounds: "0.01 0.01", audioprocessingexponent: 1 };
  check(run(narrow, snap((i) => i === 0)) === 0, "窄频带 freq=15：band0 满幅不应发射");
  check(run(narrow, snap((i) => i === 15)) > 100, "窄频带 freq=15：band15 满幅应发射");
}

// ---------- 5. 真实壁纸 shader 转译冒烟 ----------
// headers.ts 是 TS 文件，模板串里没有反引号/插值，用正则安全提取两份公共头。
{
  const headersSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/headers.ts"), "utf8");
  const extract = (name) => {
    const m = new RegExp("'" + name + "'\\s*:\\s*`([^`]*)`").exec(headersSrc);
    if (!m) throw new Error("headers.ts 缺少 " + name);
    return m[1];
  };
  const headers = {
    "common.h": extract("common.h"),
    "common_blending.h": extract("common_blending.h"),
  };
  const INCLUDE_RE = /^[ \t]*#include[ \t]+"([^"]+)"/gm;
  const expand = (src, pkgEntries, pkgData) =>
    src.replace(INCLUDE_RE, (all, name) => {
      if (headers[name]) return headers[name];
      const e = pkgEntries.find((x) => x.name === "shaders/" + name);
      if (e) return pkgData.slice(e.off, e.off + e.size).toString("utf8");
      return all; // 缺失保留，转译后会被结构检查抓出
    });

  const structCheck = (name, glsl, expectIn) => {
    check(!/^[ \t]*#(if|ifdef|ifndef|include|define)/m.test(glsl), `${name}: 预处理指令残留`);
    const open = (glsl.match(/{/g) || []).length;
    const close = (glsl.match(/}/g) || []).length;
    check(open === close && open > 0, `${name}: 花括号不平衡 ${open}/${close}`);
    check(!/\b\d+[fh]\b/.test(glsl), `${name}: f/h 后缀残留`);
    check(!/\buint\b/.test(glsl), `${name}: uint 残留`);
    // float % 非法（int % int 合法）：以「% 任一侧出现浮点字面量」为残留信号
    check(/(^|\s)[\w.)]+\s*%\s*\d+\.\d|\d+\.\d\s*%\s*[\w(]/.test(glsl) === false, `${name}: float % 残留`);
    for (const s of expectIn) check(glsl.includes(s), `${name}: 缺少 ${s}`);
  };

  // 5a. 内置 pulse（2885492021）：AUDIOPROCESSING=0 与 =3 两条路径
  const pulsePkgFile = join(LIB, "2885492021", "scene.pkg");
  if (fs.existsSync(pulsePkgFile)) {
    const buf = fs.readFileSync(pulsePkgFile);
    const pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const entrySlice = (name) => {
      const e = getEntry(pkg, name);
      return e ? Buffer.from(e) : null;
    };
    for (const stage of ["frag", "vert"]) {
      const src = entrySlice("shaders/effects/pulse." + stage);
      check(src !== null, `pkg 缺 pulse.${stage}`);
      if (!src) continue;
      const expanded = expand(src.toString("utf8"), pkg.entries, pkg.buf);
      const glslOn = hlsl2glsl(expanded, stage, { AUDIOPROCESSING: 3, PULSECOLOR: 1, PULSEALPHA: 0, MASK: 1 }, () => null);
      structCheck(`pulse.${stage}@audio=3`, glslOn, stage === "vert"
        ? ["uniform float g_AudioSpectrum16Left[16]", "CreateAudioResponse(g_AudioSpectrum16Left, g_AudioSpectrum16Right)", "smoothstep"]
        : ["ApplyBlending(9,", "v_AudioPulse"]);
      const glslOff = hlsl2glsl(expanded, stage, { AUDIOPROCESSING: 0, PULSECOLOR: 1, PULSEALPHA: 0, MASK: 1 }, () => null);
      structCheck(`pulse.${stage}@audio=0`, glslOff, stage === "vert"
        ? ["uniform mat4", "v_TexCoord = a_TexCoord.xyxy"]
        : ["sin(g_Time * g_PulseSpeed"]);
      // audio=3 时两个 stage 都含 v_AudioPulse（vert 写 / frag 读）；audio=0 时整块裁掉
      check(glslOn.includes("v_AudioPulse"), `audio=3: ${stage} 缺少 v_AudioPulse`);
      check(!glslOff.includes("v_AudioPulse"), "audio=0 时 varying 应被裁掉");
      check(!glslOff.includes("CreateAudioResponse"), "audio=0 时 CreateAudioResponse 应被裁掉");
    }
  }

  // 5b. workshop Simple_Audio_Bars（2370927443，本库音频条的公共源头）：
  // RESOLUTION 组合决定声明哪组 uniform 数组；直读频谱不经 CreateAudioResponse
  const barsPkgFile = join(LIB, "2370927443", "scene.pkg");
  if (fs.existsSync(barsPkgFile)) {
    const buf = fs.readFileSync(barsPkgFile);
    const pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    const e = getEntry(pkg, "shaders/workshop/2084198056/effects/Simple_Audio_Bars.frag");
    check(e !== undefined, "pkg 缺 Simple_Audio_Bars.frag");
    if (e) {
      const src = Buffer.from(e).toString("utf8");
      for (const res of [16, 32, 64]) {
        const expanded = expand(src, pkg.entries, pkg.buf);
        const glsl = hlsl2glsl(expanded, "frag", { RESOLUTION: res, SHAPE: 0, TRANSPARENCY: 1, A_SMOOTH_CURVE: 0, ANTIALIAS: 0, CLIP_LOW: 0, CLIP_HIGH: 0, BLENDMODE: 0 }, () => null);
        structCheck(`bars.frag@res=${res}`, glsl, [
          `uniform float g_AudioSpectrum${res}Left[${res}]`,
          `g_AudioSpectrum${res}Left[int(barFreq1)]`,
          "ApplyBlending(0,",
        ]);
        check(!glsl.includes("g_AudioSpectrum64") || res === 64, `res=${res} 泄漏了 64 组数组`);
      }
    }
  }
}

// ---------- 6. 效果常量脚本：动态颜色 ----------
// [we-scene patch] constantshadervalues 里的 {script} 此前完全没实现，setConstant
// 只读 `.value`（scene.json 里的初始快照）。全库 194 个效果常量带 script、其中
// 63 个是颜色，WE 官方「颜色循环」模板靠 update() 每帧返回 WEColor.hsv2rgb(...)
// 改写颜色 —— 不跑脚本就是**整块固定色**，音频可视化的配色全部丢失。
// 这里直接扫全库的效果常量脚本，断言颜色类全部可求值且输出随时间变化。
{
  const ids = fs.existsSync(LIB) ? fs.readdirSync(LIB).filter((d) => fs.existsSync(join(LIB, d, "scene.pkg"))) : [];
  let colorTotal = 0;
  let colorOk = 0;
  let colorDynamic = 0;
  for (const id of ids) {
    let pkg;
    let raw;
    try {
      const buf = fs.readFileSync(join(LIB, id, "scene.pkg"));
      pkg = parsePkg(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      raw = JSON.parse(Buffer.from(getEntry(pkg, "scene.json")).toString("utf8"));
    } catch { continue; }
    const walk = (o) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      if (o.constantshadervalues && typeof o.constantshadervalues === "object") {
        for (const [k, v] of Object.entries(o.constantshadervalues)) {
          if (!v || typeof v !== "object" || typeof v.script !== "string") continue;
          if (!/color|颜色/i.test(k)) continue;
          colorTotal++;
          const sb = evalObjectScript(v.script, v.scriptproperties || null, { userProperties: {} });
          // 「可求值」= 沙箱建起来。属性驱动型脚本（纯 applyUserProperties，无 update，
          // 2847470774 的两个颜色常量正是这种形态）同样合法，只是不进下面的动态判据。
          if (!sb) continue;
          colorOk++;
          if (!sb.hasUpdate) continue;
          if (sb.init) sb.init();
          const seen = new Set();
          for (const t of [0, 1, 2, 3, 5]) {
            if (sb.engine) { sb.engine.runtime = t; sb.engine.frametime = 1 / 60; }
            const arg = { x: 1, y: 1, z: 1 };
            let ret;
            try { ret = sb.callUpdate(arg); } catch { ret = undefined; }
            const src = ret !== undefined && ret !== null ? ret : arg;
            if (src && typeof src === "object") {
              const x = Number(src.x), y = Number(src.y), z = Number(src.z);
              if ([x, y, z].every(Number.isFinite)) seen.add(`${x.toFixed(3)} ${y.toFixed(3)} ${z.toFixed(3)}`);
            }
          }
          if (seen.size > 1) colorDynamic++;
        }
      }
      for (const x of Object.values(o)) walk(x);
    };
    walk(raw);
  }
  if (colorTotal > 0) {
    check(colorOk === colorTotal, `效果常量颜色脚本 ${colorTotal} 个，仅 ${colorOk} 个可求值`);
    // 全部颜色脚本都应随 engine.runtime 变化（WEColor.hsv2rgb 循环色相）。
    // 若为 0 说明沙箱缺 WEColor 或 runtime 没推进 —— 正是「整块固定色」的成因。
    check(colorDynamic > 0, `效果常量颜色脚本无一随时间变化（应有色相循环）`);
  }
}

// ---------- 7. BGM 频谱桥（mergeBgmBands）：35 张「声音层+音频反应」壁纸 ----------
{
  // TS 模块经 esbuild bundle 后在 Node 直行（与 verify-textures 同模式）
  const { build } = await import("esbuild");
  const { pathToFileURL } = await import("node:url");
  const out = await build({
    entryPoints: [join(ROOT, "renderer/src/bgm-analyser.ts")],
    bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022",
  });
  const tmp = join(ROOT, "scripts", `.tmp-bgm-${process.pid}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  let bgm;
  try {
    bgm = await import(pathToFileURL(tmp).href);
  } finally {
    fs.unlinkSync(tmp);
  }
  const arr = (n, v) => new Float32Array(n).fill(v);
  const close = (a, b) => Math.abs(a - b) < 1e-5;
  const snap = () => ({
    left64: arr(64, 0.2), right64: arr(64, 0.2),
    left32: arr(32, 0.2), right32: arr(32, 0.2),
    left16: arr(16, 0.2), right16: arr(16, 0.2),
  });
  // BGM 0.8 取 max → 0.8（不与基底相加，避免双倍）
  {
    const s = snap();
    bgm.mergeBgmBands(s, arr(64, 0.8), 1);
    check(close(s.left64[0], 0.8) && close(s.right64[10], 0.8), "BGM 0.8 应逐频段取 max 到 0.8");
  }
  // BGM 0.1 低于基底 0.2 → 保持 0.2
  {
    const s = snap();
    bgm.mergeBgmBands(s, arr(64, 0.1), 1);
    check(close(s.left64[0], 0.2), "BGM 低于基底时应保留基底（max 语义）");
  }
  // 增益 + 钳位 1
  {
    const s = snap();
    bgm.mergeBgmBands(s, arr(64, 0.9), 2);
    check(close(s.left64[0], 1), "BGM ×gain 后应钳位到 1");
  }
  // 32/16 派生数组同步降采样（max）
  {
    const s = snap();
    const band = arr(64, 0);
    band[5] = 0.7;
    bgm.mergeBgmBands(s, band, 1);
    check(s.left32.some((v) => close(v, 0.7)), "BGM 32 段降采样应取组内 max（某段含 0.7）");
    check(s.left16.some((v) => close(v, 0.7)), "BGM 16 段应同步");
  }
  // 应用层增益必须 ≤1：getByteFrequencyData 是 dB 线标，压缩母带播放时多数
  // 频段 ≥0.5，×2 一类增益会让 min(1) 把全频段钳到 1 —— 音量一开音频响应成
  // 满幅直线，静音回落模拟源才正常（用户实测 35 张 BGM 壁纸）。
  {
    const src = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    const m = /const BGM_SPECTRUM_GAIN = ([\d.]+)/.exec(src);
    check(!!m, "scene-mount 应有 BGM_SPECTRUM_GAIN 常量");
    const g = m ? Number(m[1]) : 0;
    check(g > 0 && g <= 1, `BGM_SPECTRUM_GAIN 应在 (0,1]，实得 ${g}（>1 会全频段钳满成直线）`);
  }
  // 典型音乐（全频段 0.55~0.90）经合并后必须保留起伏，不得整条钳到 1
  {
    const s = snap();
    const music = new Float32Array(64);
    for (let i = 0; i < 64; i++) music[i] = 0.55 + (i % 8) * 0.05;
    bgm.mergeBgmBands(s, music, 1);
    const ones = [...s.left64].filter((v) => v >= 0.999).length;
    check(ones < 64, `典型音乐不应全频段钳满（${ones}/64 段=1）`);
  }
}

if (errors.length) {
  console.error(`verify-audio: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-audio: all checks passed");
