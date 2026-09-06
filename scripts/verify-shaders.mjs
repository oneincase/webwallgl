#!/usr/bin/env node
/**
 * 效果 shader 转译的离线校验：不依赖浏览器、不依赖 WebGL。
 *
 * 为什么需要它：WE 的公共 shader 头（common_blending.h / common_perspective.h …）
 * **一个都不在 pkg 里**（全库 6872 个条目，.h/.inc/.glsl/.hlsl 数量为 0）。
 * 缺头时 hlsl2glsl 只插一行 `// [include 缺失]` 继续，产出的 GLSL 编不过，
 * renderLayer 又只是 console.warn 跳过**整个效果** —— 画面照常出，
 * 只是水波/色调/模糊全都没了，肉眼极难发现是哪一层丢了。
 * 所以判据必须是「转译产物里没有未定义符号」，而不是「渲染没报错」。
 *
 * 校验三项（都是纯文本/数值，可进 CI）：
 *   1. include 全部可解析（无 `[include 缺失]` 残留）；
 *   2. 无未定义符号残留 —— 被调用但既非 GLSL ES 内建、又非本文件定义、
 *      也不在我们提供的公共头里的标识符；
 *   3. 无未改写的 HLSL 方言残留（mul( / CAST* / atan2 / fmod / ddx / ddy …）
 *      与结构性检查（括号配对、#if 栈平衡）。
 *
 * 用法：
 *   node scripts/verify-shaders.mjs              全部
 *   node scripts/verify-shaders.mjs --undefined   只列未定义符号汇总
 *   node scripts/verify-shaders.mjs --item 3299228616
 *   WE_LIBRARY=/path/to/wallpapers node scripts/verify-shaders.mjs
 *
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp } from "./lib/verify-kit.mjs";
const { hlsl2glsl } = await imp("renderer/vendor/we-scene/render/hlsl2glsl.js");
const { WE_SHADER_HEADERS } = await imp("renderer/vendor/we-scene/headers.ts");

const argv = process.argv.slice(2);
const onlyItem = (() => {
  const i = argv.indexOf("--item");
  return i >= 0 ? argv[i + 1] : null;
})();
const listUndefined = argv.includes("--undefined");

// ---------- scene.pkg 读取（container.js 的最小子集，与 verify-text.mjs 同源） ----------

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
  return { entries, dataStart: p, buf, magic };
}
function getEntry(pkg, name) {
  const e = pkg.entries.find((x) => x.name === name);
  if (!e) return null;
  return pkg.buf.subarray(pkg.dataStart + e.offset, pkg.dataStart + e.offset + e.size);
}
const readText = (b) => new TextDecoder().decode(b).replace(/^\uFEFF/, "");

// 与 main.ts 的 shaderResolver 同语义：pkg 内嵌优先，缺失时回落内置公共头。
function makeResolver(pkg) {
  return (rel) => {
    const inner = rel.startsWith("shaders/") ? rel : "shaders/" + rel;
    const file = rel.startsWith("shaders/") ? rel.slice("shaders/".length) : rel;
    const e = getEntry(pkg, inner);
    if (e) return readText(e);
    return WE_SHADER_HEADERS[file] ?? null;
  };
}

// ---------- GLSL ES 3.0 内建 ----------

const GLSL_BUILTINS = new Set([
  // 数学
  "radians","degrees","sin","cos","tan","asin","acos","atan","sinh","cosh","tanh",
  "asinh","acosh","atanh","pow","exp","log","exp2","log2","sqrt","inversesqrt",
  "abs","sign","floor","trunc","round","roundEven","ceil","fract","mod","modf",
  "min","max","clamp","mix","step","smoothstep","isnan","isinf",
  "floatBitsToInt","floatBitsToUint","intBitsToFloat","uintBitsToFloat",
  "fma","frexp","ldexp",
  // 几何
  "length","distance","dot","cross","normalize","faceforward","reflect","refract",
  // 矩阵
  "matrixCompMult","outerProduct","transpose","determinant","inverse",
  // 向量关系
  "lessThan","lessThanEqual","greaterThan","greaterThanEqual","equal","notEqual",
  "any","all","not",
  // 纹理
  "texture","textureProj","textureLod","textureOffset","texelFetch","texelFetchOffset",
  "textureProjOffset","textureLodOffset","textureProjLod","textureProjLodOffset",
  "textureGrad","textureGradOffset","textureProjGrad","textureProjGradOffset",
  "textureSize","textureQueryLod",
  // 导数（片元）
  "dFdx","dFdy","fwidth",
  // 打包
  "packSnorm2x16","unpackSnorm2x16","packUnorm2x16","unpackUnorm2x16",
  "packHalf2x16","unpackHalf2x16",
  // 构造/类型（作为「调用」出现）
  "vec2","vec3","vec4","ivec2","ivec3","ivec4","uvec2","uvec3","uvec4",
  "bvec2","bvec3","bvec4","mat2","mat3","mat4",
  "mat2x2","mat2x3","mat2x4","mat3x2","mat3x3","mat3x4","mat4x2","mat4x3","mat4x4",
  "float","int","uint","bool",
  // 控制流关键字（`if (`/`for (` 会被朴素扫描当成调用）
  "if","for","while","switch","return","do","else",
]);

// ---------- 未定义符号扫描 ----------

function stripComments(src) {
  // 保留换行，便于报行号
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
}

// 本文件内定义的函数名：`TYPE NAME(` 后跟 { 或 ;（含 struct 返回类型），以及函数宏
function localDefinitions(code) {
  const defined = new Set();
  // 函数定义/前置声明：<返回类型> <名字>(...) 之后是 { 或 ;
  const re = /\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(([^;{)]*)\)\s*([;{])/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    // 排除控制流误命中（如 `else if (x) {`）
    if (GLSL_BUILTINS.has(m[2])) continue;
    if (["return", "else", "case", "default"].includes(m[1])) continue;
    defined.add(m[2]);
  }
  // struct 名（当构造函数用）
  const sre = /\bstruct\s+([A-Za-z_]\w*)/g;
  while ((m = sre.exec(code)) !== null) defined.add(m[1]);
  // 函数宏
  const dre = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)\s*\(/gm;
  while ((m = dre.exec(code)) !== null) defined.add(m[1]);
  return defined;
}

// 局部变量名（避免把 `float foo` 后的 `foo(` 误判——实际极少，但也避免把
// 形如 `myVar (a + b)` 的表达式当调用）
function calledNames(code) {
  const out = new Map(); // name -> 首次出现行号
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue; // 预处理行单独处理
    const re = /\b([A-Za-z_]\w*)\s*\(/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const name = m[1];
      // 排除「声明」形式：类型名紧跟其前（`float foo(` 是定义不是调用）
      const before = line.slice(0, m.index).trimEnd();
      if (/\b(float|int|uint|bool|void|vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234](x[234])?|struct)\s*$/.test(before)) continue;
      if (!out.has(name)) out.set(name, i + 1);
    }
  }
  return out;
}

// 宏（非函数）也可能未定义：`#if X`、以及代码里裸用的常量宏（M_PI 等）
function undefinedMacros(code, providedMacros) {
  const missing = new Map();
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#/.test(line)) continue;
    const re = /\b(M_PI|M_PI_2|M_PI_F|FORMAT_R8|FORMAT_RG88|logOf10)\b/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      if (providedMacros.has(m[1])) continue;
      if (!missing.has(m[1])) missing.set(m[1], i + 1);
    }
  }
  return missing;
}

function providedMacroNames() {
  const names = new Set();
  for (const src of Object.values(WE_SHADER_HEADERS)) {
    const re = /^[ \t]*#define[ \t]+([A-Za-z_]\w*)/gm;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  }
  return names;
}

// 结构性检查：括号配对、#if 栈平衡
function structuralIssues(code) {
  const issues = [];
  let depth = 0;
  for (const ch of code) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) issues.push(`圆括号不配对（净 ${depth}）`);
  let brace = 0;
  for (const ch of code) {
    if (ch === "{") brace++;
    else if (ch === "}") brace--;
  }
  if (brace !== 0) issues.push(`花括号不配对（净 ${brace}）`);
  let ifDepth = 0;
  for (const line of code.split("\n")) {
    const t = line.trim();
    if (/^#if(def|ndef)?\b/.test(t)) ifDepth++;
    else if (/^#endif\b/.test(t)) ifDepth--;
  }
  if (ifDepth !== 0) issues.push(`#if/#endif 不平衡（净 ${ifDepth}）`);

  // [we-scene patch] 整型循环边界被赋成 float。
  // HLSL 允许 `for (int i = someFloat; i < someFloat; ...)` 隐式收窄，
  // GLSL ES 3.00 **不允许** —— 整个 pass 编译失败，被「编译失败跳过该 pass」的
  // 兜底整趟丢掉：效果完全不出现，控制台还什么都不报
  // （2872267921 人物头部的音乐发光圆环即如此整个消失）。
  // 转译器现在会给这类裸 float 标识符套上 int()，这里守住它别退回去。
  {
    const floats = new Set();
    for (const m of code.matchAll(/\b(?:uniform[ \t]+)?(?:highp|mediump|lowp)?[ \t]*float[ \t]+([A-Za-z_]\w*)[ \t]*[;=]/g)) {
      floats.add(m[1]);
    }
    if (floats.size) {
      const re = /for\s*\(\s*(?:int|uint)\s+(\w+)\s*=\s*([^;]+);\s*\1\s*[<>]=?\s*([^;]+);/g;
      let m;
      while ((m = re.exec(code)) !== null) {
        for (const side of [m[2], m[3]]) {
          const name = side.trim().replace(/^-\s*/, "");
          if (/^[A-Za-z_]\w*$/.test(name) && floats.has(name)) {
            issues.push(`整型循环边界是 float 标识符 '${name}'（GLSL ES 3.00 无隐式收窄，整个 pass 会编译失败）`);
          }
        }
      }
    }
  }

  // [we-scene patch] float 一维数组残留二维下标。
  // WE 的 g_AudioSpectrum64* 在引擎侧是 float4[N/4]，作者写成 float[N] 再用
  // arr[i/4][i%4]；GLSL 的 float[N] 上这是编译错误，整个音频环 pass 被跳过，
  // solid 白底按 Add 合成 = 白矩形（3784370784）。
  {
    const arrs = new Set();
    for (const m of code.matchAll(/\bfloat\s+([A-Za-z_]\w*)\s*\[/g)) arrs.add(m[1]);
    for (const name of arrs) {
      const re = new RegExp("\\b" + name + "\\s*\\[[^\\]]+\\]\\s*\\[");
      if (re.test(code)) {
        issues.push(`float 数组 ${name} 残留二维下标（GLSL 无法编译，效果 pass 会被跳过）`);
      }
    }
  }
  return issues;
}

// 未改写的 HLSL 方言残留。
// 只列「转译器必须消灭、且不可能由公共头补上」的构造：
// atan2 / fmod / ddx / ddy 不在此列 —— 它们既可由公共头定义成函数（common.h 现在就
// 提供了 atan2），也可由转译器改写，两条路都合法。它们若真的没被解决，
// 会由「未定义符号」一项抓到，重复列会产生假报警。
const HLSL_LEFTOVERS = [
  ["mul(", /\bmul\s*\(/],
  ["CAST2/3/4", /\bCAST[234]\s*\(/],
  ["saturate", /\bsaturate\s*\(/],
  ["lerp", /\blerp\s*\(/],
  ["frac", /\bfrac\s*\(/],
  ["texSample2D", /\btexSample2D\b/],
  ["float2/3/4", /\bfloat[234]\b/],
  ["half", /\bhalf[234]?\b/],
  ["include 缺失", /\[include 缺失/],
  // [we-scene patch] 类型不一致：GLSL ES 没有 float↔int/bool 隐式转换，
  // 这类残留会让**整个 pass 编译失败**，而 renderLayer 只 console.warn 后跳过
  // → 图层渲染成白屏/纯色，不报错。此前本脚本只查「未定义符号」，
  // 完全漏掉类型错误，2134765860 的音频条白屏就是这样溜过去两轮的。
  ["int = float 函数", /\bint\s+\w+\s*=\s*(?:step|smoothstep|saturate|clamp|mix|lerp|frac|fract|floor|ceil|pow|sqrt|length|dot|distance)\s*\(/],
  // [we-scene patch] clamp(0, 1, x) 是工坊音频环把 saturate 写成了 min,max,x。
  // 转译器必须改成 clamp(x, 0, 1)，否则频谱高度未定义、环塌掉。
  ["clamp(0,1,x) 顺序", /\bclamp\(\s*0(?:\.0*)?\s*,\s*1(?:\.0*)?\s*,/],
];

// ---------- 主流程 ----------

function collectShaderJobs(pkg) {
  // effect → material → shader（+ 每 pass 的 combos），与 effects-parse.js 同路径
  const jobs = [];
  const sceneRaw = getEntry(pkg, "scene.json") || getEntry(pkg, "gifscene.json");
  if (!sceneRaw) return jobs;
  let sj;
  try {
    sj = JSON.parse(readText(sceneRaw));
  } catch {
    return jobs;
  }
  const seen = new Set();
  const visit = (obj) => {
    if (!obj || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const v of obj) visit(v);
      return;
    }
    for (const eff of obj.effects || []) {
      if (!eff || typeof eff.file !== "string") continue;
      const ee = getEntry(pkg, eff.file);
      if (!ee) continue;
      let ej;
      try {
        ej = JSON.parse(readText(ee));
      } catch {
        continue;
      }
      const scenePasses = eff.passes || [];
      (ej.passes || []).forEach((p, i) => {
        if (!p.material) return;
        const me = getEntry(pkg, p.material);
        if (!me) return;
        let mj;
        try {
          mj = JSON.parse(readText(me));
        } catch {
          return;
        }
        const mp = (mj.passes && mj.passes[0]) || {};
        if (!mp.shader) return;
        // combos：material 声明 + scene 覆盖（scene 优先，与 renderer 一致）
        const combos = { ...(mp.combos || {}), ...((scenePasses[i] || {}).combos || {}) };
        const key = mp.shader + "|" + JSON.stringify(combos);
        if (seen.has(key)) return;
        seen.add(key);
        jobs.push({ shader: mp.shader, combos, effect: eff.file });
      });
    }
    for (const v of Object.values(obj)) visit(v);
  };
  visit(sj.objects || []);
  // 图层材质 shader（不在 effects 里）：flowimage 等写在 materials/*.json。
  // 漏收则 833227004 这类「底图会动」的 shader 永远不进转译扫描。
  for (const o of sj.objects || []) {
    if (!o || typeof o.image !== "string") continue;
    const modelEntry = getEntry(pkg, o.image);
    if (!modelEntry) continue;
    let model;
    try { model = JSON.parse(readText(modelEntry)); } catch { continue; }
    if (!model || typeof model.material !== "string") continue;
    const matEntry = getEntry(pkg, model.material);
    if (!matEntry) continue;
    let mj;
    try { mj = JSON.parse(readText(matEntry)); } catch { continue; }
    const mp = (mj.passes && mj.passes[0]) || {};
    if (!mp.shader || !getEntry(pkg, `shaders/${mp.shader}.frag`)) continue;
    const key = mp.shader + "|" + JSON.stringify(mp.combos || {});
    if (seen.has(key)) continue;
    seen.add(key);
    jobs.push({ shader: mp.shader, combos: mp.combos || {}, effect: model.material });
  }
  return jobs;
}

const providedMacros = providedMacroNames();
// 注意：**不能**把公共头里的函数名当成「全局可用」。
// 头文件只有在该 shader 真的 #include 了它、且解析成功时才生效 ——
// 而 hlsl2glsl 会把解析成功的 include **内联进输出**，
// 所以对转译产物跑 localDefinitions 已经天然包含了头里的定义。
// 若额外维护一张「头提供的符号」白名单，就会把
// 「用了 atan2 但没 include common.h」这类真实缺陷判成通过（假阴性）。

const items = onlyItem
  ? [onlyItem]
  : fs.readdirSync(LIB).filter((d) => {
      try {
        return fs.statSync(join(LIB, d)).isDirectory();
      } catch {
        return false;
      }
    });

let totalShaders = 0;
let okShaders = 0;
const undefAgg = new Map(); // symbol -> { files:Set, wallpapers:Set }
const macroAgg = new Map();
const leftoverAgg = new Map();
const structAgg = [];
const includeMissing = new Map();
const failedWallpapers = new Set();
const scannedWallpapers = new Set();

for (const item of items) {
  const dir = join(LIB, item);
  let pkgFile = null;
  for (const cand of ["scene.pkg", "gifscene.pkg", join("scenes", "scene.pkg")]) {
    const p = join(dir, cand);
    if (fs.existsSync(p)) {
      pkgFile = p;
      break;
    }
  }
  if (!pkgFile) continue;
  let pkg;
  try {
    pkg = parsePkg(fs.readFileSync(pkgFile));
  } catch {
    continue;
  }
  scannedWallpapers.add(item);
  const resolver = makeResolver(pkg);
  const jobs = collectShaderJobs(pkg);

  for (const job of jobs) {
    // 配对 stage 的源码：combo 默认值必须两个 stage 合并看（与 renderer.js 一致）
    const pair = {
      frag: resolver('shaders/' + job.shader + '.frag') || '',
      vert: resolver('shaders/' + job.shader + '.vert') || '',
    }
    for (const stage of ["frag", "vert"]) {
      const src = pair[stage];
      if (!src) continue;
      const sibling = stage === 'frag' ? pair.vert : pair.frag;
      totalShaders++;
      let out;
      try {
        out = hlsl2glsl(src, stage, job.combos, resolver, sibling);
      } catch (e) {
        structAgg.push(`${item} ${job.shader}.${stage}: 转译抛错 ${e.message}`);
        failedWallpapers.add(item);
        continue;
      }
      const code = stripComments(out);
      const label = `${job.shader}.${stage}`;
      let clean = true;

      // include 缺失
      const im = out.match(/\[include 缺失: ([^\]]+)\]/g);
      if (im) {
        clean = false;
        for (const one of im) {
          const name = /\[include 缺失: ([^\]]+)\]/.exec(one)[1];
          if (!includeMissing.has(name)) includeMissing.set(name, { files: new Set(), wallpapers: new Set() });
          includeMissing.get(name).files.add(label);
          includeMissing.get(name).wallpapers.add(item);
        }
      }

      // 未定义符号
      const defined = localDefinitions(code);
      for (const [name, line] of calledNames(code)) {
        if (GLSL_BUILTINS.has(name)) continue;
        if (defined.has(name)) continue;
        clean = false;
        if (!undefAgg.has(name)) undefAgg.set(name, { files: new Set(), wallpapers: new Set(), sample: `${item} ${label}:${line}` });
        undefAgg.get(name).files.add(label);
        undefAgg.get(name).wallpapers.add(item);
      }

      // 未定义宏
      for (const [name] of undefinedMacros(code, providedMacros)) {
        clean = false;
        if (!macroAgg.has(name)) macroAgg.set(name, { files: new Set(), wallpapers: new Set() });
        macroAgg.get(name).files.add(label);
        macroAgg.get(name).wallpapers.add(item);
      }

      // HLSL 残留
      for (const [name, re] of HLSL_LEFTOVERS) {
        if (re.test(code)) {
          clean = false;
          if (!leftoverAgg.has(name)) leftoverAgg.set(name, { files: new Set(), wallpapers: new Set() });
          leftoverAgg.get(name).files.add(label);
          leftoverAgg.get(name).wallpapers.add(item);
        }
      }

      // 结构性（在**去注释**的代码上做括号计数：
      // 注释里的中文半角括号、区间写法 [0,1) 等会造成假报警）
      for (const iss of structuralIssues(code)) {
        clean = false;
        structAgg.push(`${item} ${label}: ${iss}`);
      }

      if (clean) okShaders++;
      else failedWallpapers.add(item);
    }
  }
}

// ---------- 报告 ----------

const pct = (a, b) => (b === 0 ? "0.0" : ((a / b) * 100).toFixed(1));
const fmt = (m) =>
  [...m.entries()]
    .sort((a, b) => b[1].files.size - a[1].files.size)
    .map(([k, v]) => `    ${String(v.files.size).padStart(4)} 文件 / ${String(v.wallpapers.size).padStart(3)} 壁纸  ${k}${v.sample ? `   例: ${v.sample}` : ""}`)
    .join("\n");

console.log(`壁纸库: ${LIB}`);
console.log(`扫描壁纸 ${scannedWallpapers.size} 个，shader 编译单元 ${totalShaders} 个`);
console.log(`转译洁净: ${okShaders}/${totalShaders} (${pct(okShaders, totalShaders)}%)`);
console.log(`受影响壁纸: ${failedWallpapers.size}/${scannedWallpapers.size}`);

if (includeMissing.size) {
  console.log(`\n[include 缺失] ${includeMissing.size} 个头`);
  console.log(fmt(includeMissing));
}
if (undefAgg.size) {
  console.log(`\n[未定义符号] ${undefAgg.size} 个`);
  console.log(fmt(undefAgg));
}
if (macroAgg.size) {
  console.log(`\n[未定义宏] ${macroAgg.size} 个`);
  console.log(fmt(macroAgg));
}
if (leftoverAgg.size) {
  console.log(`\n[HLSL 方言残留] ${leftoverAgg.size} 类`);
  console.log(fmt(leftoverAgg));
}
if (structAgg.length) {
  console.log(`\n[结构性问题] ${structAgg.length} 处`);
  for (const s of structAgg.slice(0, 20)) console.log("    " + s);
  if (structAgg.length > 20) console.log(`    …另有 ${structAgg.length - 20} 处`);
}

const wireErrors = [];
{
  const { attachLayerMaterialEffect, isBuiltinAlbedoShader } = await imp(
    "renderer/vendor/we-scene/scene/effects-parse.js",
  );
  if (isBuiltinAlbedoShader("genericimage2") !== true) {
    wireErrors.push("genericimage2 必须判为内置反照率直通（不得挂进效果链）");
  }
  if (isBuiltinAlbedoShader("flowimage") !== false) {
    wireErrors.push("flowimage 不得判为内置直通");
  }
  const dummy = { effects: [] };
  const attached = attachLayerMaterialEffect(dummy, {
    shader: "flowimage",
    textures: ["background", "flowmask"],
    constantshadervalues: { Speed: 0.07, Amount: 1, Bright: 1 },
  });
  if (!attached) wireErrors.push("attachLayerMaterialEffect(flowimage) 必须成功");
  const mp = dummy.effects[0] && dummy.effects[0].materialPasses && dummy.effects[0].materialPasses[0];
  if (!mp || mp.shader !== "flowimage") wireErrors.push("图层材质必须变成效果链第一趟，shader=flowimage");
  if (!mp || !(mp.textures || []).includes("flowmask")) wireErrors.push("flowmask 必须进 materialPasses.textures（g_Texture1）");
  if (!mp || mp.constants.Speed !== 0.07) wireErrors.push("Speed 常量必须带到 materialPasses.constants");
  if (attachLayerMaterialEffect({ effects: [] }, { shader: "genericimage4", textures: ["x"] })) {
    wireErrors.push("genericimage4 不得被挂进效果链");
  }
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  if (!/attachLayerMaterialEffect/.test(mountSrc)) {
    wireErrors.push("scene-mount.ts 未调用 attachLayerMaterialEffect（图层材质 shader 没接线）");
  }
  if (!/texSlots/.test(mountSrc) && !/textures \|\| \[\]/.test(mountSrc)) {
    wireErrors.push("scene-mount.ts 必须遍历 material 全部纹理槽（不能只 load textures[0]）");
  }
  // 真实语料：两张 flowimage 壁纸的 shader 必须被 collectShaderJobs 收到
  for (const id of ["833227004", "820654165"]) {
    const p = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(p)); } catch { continue; }
    const jobs = collectShaderJobs(pkg);
    if (!jobs.some((j) => j.shader === "flowimage")) {
      wireErrors.push(`${id} 的 flowimage 必须进入 shader 扫描（图层材质漏收）`);
    }
  }
  // [we-scene patch] 工坊音频环：float[64] 二维下标 + mix(vec3,vec4) + return 截断。
  // 转译失败 → 效果被跳过 → solid 白底 Add 合成白块（3784370784）。
  {
    const ringSrc = [
      "uniform float g_AudioSpectrum64Left[64];",
      "uniform vec3 u_userNewColor;",
      "vec3 drawSence(vec2 uv) {",
      "  vec4 col = vec4(0.,0.,0.,0.);",
      "  float barID = 1.;",
      "  float v = clamp(0. , 1., g_AudioSpectrum64Left[barID / 4][barID % 4]);",
      "  col = vec4(mix(u_userNewColor, col, step(0., 1.)), 1.);",
      "  return col;",
      "}",
      "varying vec2 v_TexCoord;",
      "void main() { gl_FragColor = vec4(drawSence(v_TexCoord), 1.); }",
    ].join("\n");
    const glsl = hlsl2glsl(ringSrc, "frag", {}, () => null);
    if (/g_AudioSpectrum64Left\s*\[[^\]]+\]\s*\[/.test(glsl)) {
      wireErrors.push("float[64] 二维下标必须展平为 int(a)*4+int(b)");
    }
    if (!/int\(\(/.test(glsl)) {
      wireErrors.push("packed 频谱下标必须套 int()");
    }
    if (!/mix\(\s*u_userNewColor\s*,\s*col\.xyz/.test(glsl)) {
      wireErrors.push("mix(vec3, vec4) 必须把 vec4 截成 .xyz");
    }
    if (!/return col\.xyz/.test(glsl)) {
      wireErrors.push("vec3 函数 return vec4 必须截断");
    }
    if (/\bclamp\(\s*0/.test(glsl)) {
      wireErrors.push("clamp(0, 1, x) 必须改成 clamp(x, 0, 1)");
    }
    const hlslSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hlsl2glsl.js"), "utf8");
    if (!/float 一维数组的二维下标/.test(hlslSrc)) {
      wireErrors.push("hlsl2glsl.js 必须包含 float 数组二维下标展平");
    }
  }
  const ringPkg = join(LIB, "3784370784", "scene.pkg");
  if (fs.existsSync(ringPkg)) {
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(ringPkg)); } catch { pkg = null; }
    const frag = pkg && getEntry(pkg, "shaders/workshop/3605510527/effects/video.frag");
    const vert = pkg && getEntry(pkg, "shaders/workshop/3605510527/effects/video.vert");
    if (!frag) {
      wireErrors.push("3784370784 必须含 workshop/3605510527/video.frag");
    } else {
      const glsl = hlsl2glsl(readText(frag), "frag", {}, makeResolver(pkg), vert ? readText(vert) : "");
      if (/g_AudioSpectrum64Left\s*\[[^\]]+\]\s*\[/.test(glsl)) {
        wireErrors.push("3784370784 video.frag 二维频谱下标必须展平");
      }
      if (!/mix\(\s*u_userNewColor\s*,\s*col\.xyz/.test(glsl)) {
        wireErrors.push("3784370784 video.frag mix(vec3, vec4) 必须截断");
      }
      if (!/return col\.xyz/.test(glsl)) {
        wireErrors.push("3784370784 video.frag return 必须截断 vec4");
      }
    }
  }
}

// [we-scene patch] **int→float 隐式转换**（godrays_cast / shine_cast 体积光）。
// WE 官方效果模板写 `const float sampleDrop = sampleCount - 1;`（int 表达式赋给
// float）与 `i / sampleDrop`（int / float）。HLSL 两者都隐式转换，GLSL ES 全拒：
//   ERROR: '=' : cannot convert from 'const mediump int' to 'const highp float'
//   ERROR: '/' : wrong operand types - no operation '/' exists that takes ...
// 整个 cast pass 被跳过 → 体积光/光晕整条效果消失（1315534440 首现）。
// 全库 46 处 / 38 张壁纸，两类数量完全相同（同一模板语句的上下游）。
{
  const castSrc = [
    "varying vec2 v_TexCoord;",
    "uniform sampler2D g_Texture0;",
    "uniform float g_Length;",
    "void main() {",
    "  vec2 texCoords = v_TexCoord;",
    "  vec4 albedo = vec4(0.0);",
    "  vec2 direction = vec2(0.5) - texCoords;",
    "  float dist = length(direction);",
    "  const int sampleCount = 30;",
    "  const float sampleDrop = sampleCount - 1;",
    "  direction = direction * dist / sampleDrop;",
    "  for (int i = 0; i < sampleCount; ++i) {",
    "    vec4 smp = texSample2D(g_Texture0, texCoords);",
    "    albedo += smp * (i / sampleDrop);",
    "  }",
    "  gl_FragColor = albedo;",
    "}",
  ].join("\n");
  const glsl = hlsl2glsl(castSrc, "frag", {}, () => null);
  // 1) float 声明 = 纯整型表达式 → float(...) 包裹
  if (/\bfloat\s+sampleDrop\s*=\s*sampleCount\s*-\s*1\s*;/.test(glsl)) {
    wireErrors.push(
      "float 声明的纯整型右值必须包 float()：`const float sampleDrop = sampleCount - 1;` " +
        "在 GLSL ES 报 cannot convert from int to float，整个 godrays/shine cast pass 被跳过",
    );
  }
  if (!/\bfloat\s+sampleDrop\s*=\s*float\(sampleCount\s*-\s*1\)/.test(glsl)) {
    wireErrors.push("sampleDrop 应改写为 float(sampleCount - 1)");
  }
  // 2) int 循环变量与 float 混合运算 → float(i)
  if (/\(\s*i\s*\/\s*sampleDrop\s*\)/.test(glsl)) {
    wireErrors.push(
      "int 与 float 的混合二元运算必须包 float()：`i / sampleDrop` 在 GLSL ES 报 " +
        "wrong operand types（GLSL 无任何混合类型运算符重载）",
    );
  }
  if (!/float\(i\)\s*\/\s*sampleDrop/.test(glsl)) {
    wireErrors.push("循环变量 i 与 float 相除应改写为 float(i) / sampleDrop");
  }
  // 3) 不得误伤：右值含小数点的 float 声明本来合法，不该被包。
  //    `n * 0.5` 含小数点、无函数调用 → 只触发小数点那道检查，可独立证伪。
  //
  //    注：函数调用（`float bar = max(barLeft, barRight);`，2134765860 的形态）
  //    也不会被改写，但那是 `ids.every(intNames.has)` 的**天然结果** —— 函数名
  //    本身也进 ids 且不在 intNames 里，判定必然失败。所以 10b-2 里那道显式的
  //    函数调用检查是冗余的（保留是为了让意图直白、不依赖这层间接推理），
  //    删掉它行为不变，因此不为它写断言 —— 那会是一条永远不会红的假绿。
  const okSrc = [
    "void main() {",
    "  const int n = 4;",
    "  float a = n * 0.5;",
    "  gl_FragColor = vec4(a);",
    "}",
  ].join("\n");
  const okGlsl = hlsl2glsl(okSrc, "frag", {}, () => null);
  if (/float\s+a\s*=\s*float\(/.test(okGlsl)) {
    wireErrors.push("右值已含小数点的 float 声明不得被包 float()（n * 0.5 已是 float 表达式）");
  }
  // 4) 顺序守卫：10b 把 `int x = step(...)` 改成 float 之后，x 不再是 int，
  //    混合运算改写不得再给它套 float()（2134765860 Simple_Audio_Bars 的 bar）。
  //    收集 int 名字若跑在 10b 之前就会多包一层，掩盖真实类型。
  const barSrc = [
    "uniform float u_BarOpacity;",
    "void main() {",
    "  float barHeight = 0.5;",
    "  int bar = step(0.25, barHeight);",
    "  float alpha = bar * u_BarOpacity;",
    "  gl_FragColor = vec4(alpha);",
    "}",
  ].join("\n");
  const barGlsl = hlsl2glsl(barSrc, "frag", {}, () => null);
  if (!/\bfloat\s+bar\s*=\s*step\(/.test(barGlsl)) {
    wireErrors.push("`int bar = step(...)` 应由 10b 改成 float 声明");
  }
  if (/float\(bar\)\s*\*\s*u_BarOpacity/.test(barGlsl)) {
    wireErrors.push(
      "已被 10b 转成 float 的变量不得再套 float()：说明 int 名字收集跑在 10b 之前（顺序错）",
    );
  }
  // 5) 源码守卫：两段共用同一个 collectIntNames，且必须在 10b 之后
  const hlslSrc2 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hlsl2glsl.js"), "utf8");
  if (!/function collectIntNames\s*\(/.test(hlslSrc2)) {
    wireErrors.push("hlsl2glsl.js 必须有共用的 collectIntNames（两段各写一份会漂移成半修状态）");
  }
  // 两段都必须真的调用它 —— 只要有一段自己内联收集，就会出现「声明改对了、
  // 运算没改」的半修状态：pass 依旧编译失败，但症状与完全没修一模一样。
  if ((hlslSrc2.match(/collectIntNames\(code\)/g) || []).length < 2) {
    wireErrors.push("10b-2 与 10b-3 都必须调用 collectIntNames（少一处即半修）");
  }
  const idx10b = hlslSrc2.indexOf("const FLOAT_FNS");
  const idxB2 = hlslSrc2.indexOf("10b-2)");
  const idxB3 = hlslSrc2.indexOf("10b-3)");
  if (idx10b < 0 || idxB2 < 0 || idxB3 < 0) {
    wireErrors.push("hlsl2glsl.js 缺少 10b-2 / 10b-3 段（int→float 隐式转换）");
  } else if (!(idx10b < idxB2 && idxB2 < idxB3)) {
    wireErrors.push("10b-2 / 10b-3 必须排在 10b（int x = step(...) → float）之后");
  }
}

// [we-scene patch] **整数字面量补 .0 必须迭代到不动点**。
// 这些都是单趟正则，而 HLSL 链式表达式要多趟收敛：`#define kernel 2` 展开出的
// `2 + 2 + 2.0`（gaussian.frag，7 张）第一趟只改紧邻浮点的那个，留下 `2 + 2.0 + 2.0`，
// 最左的 2 右边仍是整数、规则不认 → int + float 编不过，整个 pass 被跳过。
// 另外三个缺口：`1 / (1.0 - t)`（perspective.vert，3 张，字面量后紧跟括号）、
// `(xScale - 1) * 0.5`（rounded_mask.vert，5 张，float 变量在左、裸整数在右）、
// `(1 + (abs(u)+abs(u)) * 2.0)`（shadow.vert，3 张，浮点特征在紧邻括号之后）。
{
  const cases = [
    // [标签, 源码, 期望出现, 不得出现]
    [
      "宏展开的整数链",
      "#define kernel 2\nvoid main(){ vec4 a=vec4(1.0); a.rgb /= kernel + kernel + 2.0; gl_FragColor=a; }",
      /a\.rgb \/= 2\.0 \+ 2\.0 \+ 2\.0/,
      /a\.rgb \/= 2 \+/,
    ],
    [
      "整数字面量后紧跟括号",
      "void main(){ float t=0.5; float q0 = 1 / (1 - t); gl_FragColor=vec4(q0); }",
      /q0 = 1\.0 \/ \(1\.0 - t\)/,
      /q0 = 1 \//,
    ],
    [
      "float 变量在左、裸整数在右",
      "void main(){ float xScale = max(1.0, 2.0); float v = 0.0; v -= (xScale - 1) * 0.5; gl_FragColor=vec4(v); }",
      /\(xScale - 1\.0\) \* 0\.5/,
      /\(xScale - 1\) \*/,
    ],
    [
      "浮点特征在紧邻括号之后",
      "void main(){ float u=0.3; float a = (1 + (abs(u) + abs(u)) * 2.0) * max(1.0, abs(u)); gl_FragColor=vec4(a); }",
      /\(1\.0 \+ \(abs\(u\)/,
      /\(1 \+ \(abs/,
    ],
  ];
  for (const [label, src, want, bad] of cases) {
    const glsl = hlsl2glsl(src, "frag", {}, () => null);
    if (bad.test(glsl)) wireErrors.push(`整浮混合未修（${label}）：GLSL ES 无 int/float 混合运算，整个 pass 被跳过`);
    else if (!want.test(glsl)) wireErrors.push(`整浮混合改写形态不符预期（${label}）`);
  }
  // 不得误伤纯整数上下文：`int m = 3 * (k + 1)` 被补成 3.0 会反过来报
  // cannot convert float to int（把一类失败换成另一类）。
  const intCtx = hlsl2glsl(
    "void main(){ int k=7; int m = 3 * (k + 1); gl_FragColor=vec4(float(m)); }",
    "frag",
    {},
    () => null,
  );
  if (/3\.0 \* \(k \+ 1\)/.test(intCtx)) {
    wireErrors.push("纯整数括号表达式不得补 .0（int m = 3 * (k + 1) 会变成 float→int 错误）");
  }
  // 源码守卫：这一段必须在循环里，且 floatNames 块也在循环内 ——
  // perspective 的 `1 / (1 - t)` 需要先由 floatNames 块把 `1 - t` 改成 `1.0 - t`，
  // 括号扫描下一轮才看得到小数点。floatNames 留在循环外时第二轮因 code 未变而 break。
  const hs = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hlsl2glsl.js"), "utf8");
  const loopStart = hs.indexOf("for (let pass = 0; pass < 8; pass++)");
  const loopEnd = hs.indexOf("if (code === before) break");
  if (loopStart < 0 || loopEnd < 0) {
    wireErrors.push("hlsl2glsl.js 的整浮混合改写必须包在迭代到不动点的循环里");
  } else {
    const body = hs.slice(loopStart, loopEnd);
    if (!/floatNames/.test(body)) {
      wireErrors.push("floatNames 块必须在不动点循环内（否则 1 / (1 - t) 这类两趟依赖修不到）");
    }
  }
}

// [we-scene patch] **同名 float 声明优先于 width 表**（9b 标量广播的闸门）。
// width 表用 `vecN <名字>` 全文扫，会把函数签名形参一起收进来：common_blending.h
// 有 24 个 `vec3 BlendXxx(vec3 base, vec3 blend)`，于是 blend 被登记成 vec3。
// blendgradient.frag 的 main() 里却是 `float blend = 1.0;`，广播成
// `blend = vec3(smoothstep(…))` 后报 dimension mismatch —— 24 张壁纸的混合渐变全灭，
// 而作者原式完全合法。
{
  const src = [
    "vec3 BlendLinearDodge(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }",
    "uniform float g_Multiply;",
    "void main() {",
    "  float gradient = 0.5;",
    "  float blend = 1.0;",
    "  blend = smoothstep(saturate(gradient - 0.1), saturate(gradient + 0.1), g_Multiply);",
    "  gl_FragColor = vec4(blend);",
    "}",
  ].join("\n");
  const glsl = hlsl2glsl(src, "frag", {}, () => null);
  if (/blend = vec3\s*\(/.test(glsl)) {
    wireErrors.push(
      "局部 `float blend` 不得被 9b 广播成 vec3：width 表收了 common_blending.h 的函数形参，" +
        "同名 float 声明必须优先（24 张壁纸的混合渐变 pass）",
    );
  }
  // 反向：真正的 vecN 变量仍要能被标量广播（否则 sine_wave 一类会回归）
  const vecSrc = [
    "uniform float u_Amp;",
    "void main() {",
    "  vec2 waveCoord = vec2(0.0);",
    "  waveCoord = pow(saturate(u_Amp), 2.0);",
    "  gl_FragColor = vec4(waveCoord, 0.0, 1.0);",
    "}",
  ].join("\n");
  const vecGlsl = hlsl2glsl(vecSrc, "frag", {}, () => null);
  if (!/waveCoord = vec2\s*\(/.test(vecGlsl)) {
    wireErrors.push("真正的 vecN 变量仍须被标量广播（闸门收得过紧会让 sine_wave 一类回归）");
  }
}

// [we-scene patch] **内联比较表达式参与算术**：`depth *= (depth < 0.6) * 6.0;`
// （gaussian.frag 的 PRECISE 分支，16 pass / 6 壁纸）。HLSL 把 bool 当 0/1 提升，
// GLSL ES 报 `'*' : … 'bool' and … 'float'`，整个高斯模糊 pass 被跳过。
// 既有的 10c 只认已声明的 bool 变量名，内联比较没有变量可收集。
{
  const hit = hlsl2glsl(
    "void main(){ float depth=0.5; depth *= (depth < 0.6) * 6.0; gl_FragColor=vec4(depth); }",
    "frag",
    {},
    () => null,
  );
  if (!/float\(depth < 0\.6\)/.test(hit)) {
    wireErrors.push("内联比较参与算术必须包 float()：(depth < 0.6) * 6.0 在 GLSL ES 编不过");
  }
  // 不得误伤条件语句：if / 三元 / for / while 里的比较必须原样保留
  const guards = [
    ["if", "void main(){ float d=0.5; float o=0.0; if (d < 0.6) { o=1.0; } gl_FragColor=vec4(o); }", /if \(d < 0\.6\)/],
    ["三元", "void main(){ float d=0.5; float o = (d < 0.6) ? 1.0 : 0.0; gl_FragColor=vec4(o); }", /\(d < 0\.6\) \?/],
    ["while", "void main(){ float s=0.0; int i=0; while ((i < 3)) { s+=1.0; i++; } gl_FragColor=vec4(s); }", /while \(\(i < 3\)\)/],
    ["逻辑与", "void main(){ float a=1.0,b=2.0; float o=0.0; if ((a < b && b < 3.0)) o=1.0; gl_FragColor=vec4(o); }", /a < b && b < 3\.0/],
  ];
  for (const [label, src, want] of guards) {
    const g = hlsl2glsl(src, "frag", {}, () => null);
    if (!want.test(g)) wireErrors.push(`条件语句里的比较不得被包 float()（${label}）`);
  }
}

// [we-scene patch] **科学计数法字面量整体挖洞**（在补 .0 的全部规则之前）。
// `1e-6` 指数部分的数字前面是 `-`，逃不过那些「整数字面量」正则的负向后顾，
// 被改成 `1.0e-6.0` → ANGLE 报 `'.0' : syntax error`，整个 pass 被跳过
// （procedural_noise / lens_distortion / frame_builder / oscilloscope，8 pass / 7 壁纸）。
// 作者写的是防除零下限 max(1e-6, x)，本来完全合法。
{
  const one = hlsl2glsl(
    "uniform float u_fps;\nvoid main(){ float v = max(1e-6, u_fps); gl_Position=vec4(v); }",
    "vert",
    {},
    () => null,
  );
  if (/1\.0e-6\.0|e-6\.0/.test(one)) {
    wireErrors.push("科学计数法字面量被补 .0（1e-6 → 1.0e-6.0），必须在补 .0 之前整体挖洞保护");
  }
  if (!/max\(1e-6,/.test(one)) {
    wireErrors.push(`科学计数法字面量未原样保留：${(one.match(/max\([^)]*\)/) || ["?"])[0]}`);
  }
  // 多个字面量共存时回填索引不能错位 —— 占位符里若含十进制数字，序号本身会被
  // 补 .0 规则改写（\u00010\u0001 → \u00010.0\u0001），回填后 1e-6 会变成 0.0：
  // 静默算错，比原缺陷更糟（不报编译错）。故占位符用一元记数。
  const multi = hlsl2glsl(
    "uniform float a;\nvoid main(){ float x = max(1e-6, a) + max(2.5e-3, a) * 1e10; gl_Position=vec4(x); }",
    "vert",
    {},
    () => null,
  );
  for (const lit of ["1e-6", "2.5e-3", "1e10"]) {
    if (!multi.includes(lit)) {
      wireErrors.push(`多个科学计数法共存时 ${lit} 回填错位（占位符不得含十进制数字）`);
    }
  }
}

// [we-scene patch] **写 varying 的副本机制不得撞上作者的同名局部量**。
// HLSL 允许局部量遮蔽 varying：chromatic_aberration.frag 顶部 `varying vec4 timer;`，
// main() 里又写 `vec4 timer = texSample2D(...)`。无条件造副本会插入
// `vec4 timer_rw = timer;`，而作者那句也被整词替换成同名声明 → `redefinition`，
// 整个色散 pass 被跳过（timer/rValue/gValue/bValue 四名同时中招，7 pass / 7 壁纸）。
{
  const shadowed = [
    "varying vec4 timer;",
    "uniform sampler2D g_Texture0;",
    "varying vec2 v_TexCoord;",
    "void main() {",
    "  vec4 timer = texSample2D(g_Texture0, v_TexCoord);",
    "  timer.x += 0.1;",
    "  gl_FragColor = timer;",
    "}",
  ].join("\n");
  const g1 = hlsl2glsl(shadowed, "frag", {}, () => null);
  if ((g1.match(/\btimer_rw\s*=/g) || []).length > 1) {
    wireErrors.push("作者已声明同名局部量时不得再造 _rw 副本（会 redefinition，整个 pass 被跳过）");
  }
  // 反向：真正需要副本的场景（写 varying 但无局部声明）必须照旧工作
  const needsCopy = [
    "varying vec2 v_TexCoord;",
    "uniform sampler2D g_Texture0;",
    "void main() {",
    "  v_TexCoord.y += 0.1;",
    "  gl_FragColor = texSample2D(g_Texture0, v_TexCoord);",
    "}",
  ].join("\n");
  const g2 = hlsl2glsl(needsCopy, "frag", {}, () => null);
  if (!/vec2 v_TexCoord_rw = v_TexCoord;/.test(g2)) {
    wireErrors.push("写入 varying 但无同名局部量时仍须造 _rw 副本（GLSL ES 的 in 是只读的）");
  }
}

// [we-scene patch] **声明式初始化的向量→标量截断**：
// `float mask = texSample2D(...)`（sharpen_filter）/
// `float pointer = g_PointerPosition.yx * u_speed`（chromatic_aberration）。
// 第 9 段只处理「已声明变量之间的赋值」，不看声明式初始化。
{
  const t1 = hlsl2glsl(
    "uniform sampler2D g_Texture1;\nvarying vec2 v_TexCoord;\nvoid main(){ float mask = texSample2D(g_Texture1, v_TexCoord); gl_FragColor=vec4(mask); }",
    "frag",
    {},
    () => null,
  );
  if (!/float mask = \(texture\([^)]*\)\)\.x;/.test(t1)) {
    wireErrors.push("float x = texture(...) 必须截断成 .x（GLSL ES 无 vec4→float 隐式转换）");
  }
  const t2 = hlsl2glsl(
    "uniform vec2 g_PointerPosition;\nuniform float u_s;\nvoid main(){ float p = g_PointerPosition.yx * u_s; gl_FragColor=vec4(p); }",
    "frag",
    {},
    () => null,
  );
  if (!/float p = \(g_PointerPosition\.yx \* u_s\)\.x;/.test(t2)) {
    wireErrors.push("float x = <向量 op 标量> 必须截断成 .x");
  }
  // 不得误伤本来就是标量的右值：两侧都是 float / length / dot / vec.x
  const safe = [
    ["float*float", "uniform float a, b;\nvoid main(){ float v = a * b; gl_FragColor=vec4(v); }"],
    ["length(vec)", "uniform vec3 c;\nvoid main(){ float v = length(c); gl_FragColor=vec4(v); }"],
    ["dot(a,b)", "uniform vec3 a,b;\nvoid main(){ float v = dot(a, b); gl_FragColor=vec4(v); }"],
    ["vec.x*float", "uniform vec3 c;\nuniform float k;\nvoid main(){ float v = c.x * k; gl_FragColor=vec4(v); }"],
  ];
  for (const [label, src] of safe) {
    const g = hlsl2glsl(src, "frag", {}, () => null);
    if (/float v = \(.*\)\.x;/.test(g)) {
      wireErrors.push(`标量右值不得被截断（${label}）：会报 field selection requires vector`);
    }
  }
  // common_blending.h 的形参污染同样要挡住（与 9b 闸门同源）：
  // `float blendAlpha = blend * g_Multiply;` 两侧都是 float，blend 却在 width 表里。
  const blendSrc = [
    "vec3 BlendLinearDodge(vec3 base, vec3 blend) { return min(base + blend, vec3(1.0)); }",
    "uniform float g_Multiply;",
    "void main() {",
    "  float blend = 0.5;",
    "  float blendAlpha = blend * g_Multiply;",
    "  gl_FragColor = vec4(blendAlpha);",
    "}",
  ].join("\n");
  const bg = hlsl2glsl(blendSrc, "frag", {}, () => null);
  if (/float blendAlpha = \(.*\)\.x;/.test(bg)) {
    wireErrors.push("同名 float 声明优先于 width 表（否则 blend * g_Multiply 被误截断）");
  }
}

// [we-scene patch] **`for (int …)` 循环头必须在补 .0 之前挖洞保护**。
// common.h 有 `float atan2(float y, float x)`，其形参 y/x 被 floatNames 收进来，
// 于是「float 变量 ± 整数」把 `for (int y = -1; ...)` 的 -1 补成 -1.0，
// ANGLE 报 `cannot convert from 'const float' to 'mediump int'`（7 pass / 3 壁纸）。
{
  const loopSrc = [
    "float atan2(float y, float x) { return atan(y, x); }",
    "void main() {",
    "  float s = 0.0;",
    "  for (int y = -1; y <= 1; y++) { for (int x = -1; x <= 1; x++) { s += 1.0; } }",
    "  gl_FragColor = vec4(s);",
    "}",
  ].join("\n");
  const g = hlsl2glsl(loopSrc, "frag", {}, () => null);
  if (/for \(int [xy] = -1\.0/.test(g)) {
    wireErrors.push("for (int …) 循环头里的整数不得补 .0（float→int 转换失败，整个 pass 被跳过）");
  }
  // 回填点的取值范围很窄，两边都撞过墙 —— 这两条守住它：
  // 1) 挖洞必须仍让 collectIntNames 认出循环变量（否则 godrays 的 float(i) 丢失）
  const godrays = hlsl2glsl(
    "void main(){ vec4 a=vec4(0.0); const int n=30; const float d = n - 1; for (int i=0;i<n;++i){ a += vec4(1.0) * (i / d); } gl_FragColor=a; }",
    "frag",
    {},
    () => null,
  );
  if (!/float\(i\) \/ d/.test(godrays)) {
    wireErrors.push("for 头挖洞后 collectIntNames 仍须认出循环变量（否则 i / float 不被改写）");
  }
  // 2) 回填必须早于「整型循环边界 float→int」那条规则
  const bound = hlsl2glsl(
    "uniform float u_It;\nvoid main(){ float s=0.0; for (int i = 0; i < u_It; i++) s+=1.0; gl_FragColor=vec4(s); }",
    "frag",
    {},
    () => null,
  );
  if (!/i < int\(u_It\)/.test(bound)) {
    wireErrors.push("for 头回填必须早于循环边界 float→int 规则（否则 i < u_Iterations 不再包 int()）");
  }
}

// [we-scene patch] **一维数组下标是 float 时包 int()**：
// `float index = floor(v_TexCoord.x * 64.0); … arr[index]` —— HLSL 隐式取整，
// GLSL ES 报 `'[]' : integer expression required`（7 pass / 4 壁纸）。
{
  const g = hlsl2glsl(
    "uniform float arr[64];\nvarying vec2 v_TexCoord;\nvoid main(){ float index = floor(v_TexCoord.x * 64.0); float a = arr[index]; gl_FragColor=vec4(a); }",
    "frag",
    {},
    () => null,
  );
  if (!/arr\[int\(index\)\]/.test(g)) {
    wireErrors.push("float 变量作数组下标必须包 int()（GLSL ES 要求整型下标）");
  }
  // 不得误伤：整数字面量下标 / 循环变量 / 已写 int() / 二维展平
  const safe = [
    ["整数字面量", "uniform float arr[8];\nvoid main(){ float v = arr[2]; gl_FragColor=vec4(v); }", /arr\[2\]/],
    ["循环变量", "uniform float arr[8];\nvoid main(){ float s=0.0; for(int i=0;i<8;i++) s += arr[i]; gl_FragColor=vec4(s); }", /arr\[i\]/],
    ["已写 int()", "uniform float arr[8];\nuniform float u_k;\nvoid main(){ float v = arr[int(u_k)]; gl_FragColor=vec4(v); }", /arr\[int\(u_k\)\]/],
  ];
  for (const [label, src, want] of safe) {
    const s = hlsl2glsl(src, "frag", {}, () => null);
    if (!want.test(s)) wireErrors.push(`数组下标不得被重复包裹（${label}）`);
  }
  // 二维 packed 下标展平仍须工作（10d 的既有能力）
  const two = hlsl2glsl(
    "uniform float g_AudioSpectrum64Left[64];\nvoid main(){ float b=1.0; float v = g_AudioSpectrum64Left[b/4][b%4]; gl_FragColor=vec4(v); }",
    "frag",
    {},
    () => null,
  );
  if (!/\* 4 \+ int\(/.test(two)) {
    wireErrors.push("float[64] 的二维 packed 下标展平不得被一维规则截断");
  }
}

// [we-scene patch] **宏展开产生的相邻符号**：`-SHADOWMASK_HORIZGAPWIDTH` 而
// `#define SHADOWMASK_HORIZGAPWIDTH -1.3` → `--1.3`。HLSL 按数值折叠（= +1.3）；
// GLSL 把 `--` 当自减，报 `l-value required (can't modify a const)`（6 pass / 4 壁纸）。
{
  const g = hlsl2glsl(
    "#define W -1.3\nfloat G(float x, float o){ return x+o; }\nvoid main(){ float v = G(0.5, -W); gl_FragColor=vec4(v); }",
    "frag",
    {},
    () => null,
  );
  if (/--1\.3/.test(g)) {
    wireErrors.push("宏展开出的 `--<数字>` 必须折叠成 +（GLSL 会当自减运算符）");
  }
  if (!/G\(0\.5, \+1\.3\)/.test(g)) {
    wireErrors.push(`--1.3 应折叠成 +1.3，实得 ${(g.match(/G\([^)]*\)/) || ["?"])[0]}`);
  }
  // 真自增/自减与「减负号变量」不得被碰
  const keep = [
    ["自减 i--", "void main(){ float s=0.0; for(int i=8;i>0;i--) s+=1.0; gl_FragColor=vec4(s); }", /i--/],
    ["自增 i++", "void main(){ float s=0.0; for(int i=0;i<8;i++) s+=1.0; gl_FragColor=vec4(s); }", /i\+\+/],
    ["a - -b", "uniform float a,b;\nvoid main(){ float v = a - -b; gl_FragColor=vec4(v); }", /a - -b/],
  ];
  for (const [label, src, want] of keep) {
    const s = hlsl2glsl(src, "frag", {}, () => null);
    if (!want.test(s)) wireErrors.push(`真自增/自减与变量取负不得被折叠（${label}）`);
  }
}

// [we-scene patch] **窄向量声明接更宽右值需截断** + **float x = int(...)**。
// `vec3 albedo = texSample2D(...)`（cutout_vignette / shimmer，4 pass / 4 壁纸）；
// `float iterations = int(u_iterations)`（blur_gaussian，4 pass / 2 壁纸，
// 作者想取整，所以外面包 float() 而不是删掉 int()——删掉会改变数值与循环边界）。
{
  const g1 = hlsl2glsl(
    "uniform sampler2D g_Texture0;\nvarying vec4 v_TexCoord;\nvoid main(){ vec3 albedo = texSample2D(g_Texture0, v_TexCoord.xy); gl_FragColor=vec4(albedo,1.0); }",
    "frag",
    {},
    () => null,
  );
  if (!/vec3 albedo = \(texture\([^;]*\)\)\.xyz;/.test(g1)) {
    wireErrors.push("vec3 x = texture(...) 必须截成 .xyz（GLSL ES 无 vec4→vec3 隐式转换）");
  }
  const g2 = hlsl2glsl(
    "uniform float u_it;\nvoid main(){ float iterations = int(u_it); gl_FragColor=vec4(iterations); }",
    "frag",
    {},
    () => null,
  );
  if (!/float iterations = float\(int\(u_it\)\);/.test(g2)) {
    wireErrors.push("float x = int(...) 必须包 float() 保留取整语义（不能删掉 int()）");
  }
  // vec4 = texture 本来合法，不得多包
  const g3 = hlsl2glsl(
    "uniform sampler2D g_T;\nvarying vec2 uv;\nvoid main(){ vec4 a = texSample2D(g_T, uv); gl_FragColor=a; }",
    "frag",
    {},
    () => null,
  );
  if (/vec4 a = \(texture/.test(g3)) {
    wireErrors.push("vec4 = texture(...) 同宽，不得被截断包裹");
  }
}

// [we-scene patch] **宏只对它自己的 #define 行之后生效**（C 预处理器语义）。
// light_map.frag 的 `#else` 分支有 `#define emitters 1.0`，而它**上方**的
// `vec3 lightMap = CAST3(0.0), emitters;` 是变量声明。全文替换会把声明也换成
// `…, 1.0` → `'1.0' : syntax error`，整个 light_map pass 被跳过（5 pass / 5 壁纸）。
{
  const src = [
    "vec3 lightMap = vec3(0.0), emitters;",
    "#define emitters 1.0",
    "void main() {",
    "  lightMap = lightMap * emitters;",
    "  gl_FragColor = vec4(lightMap, 1.0);",
    "}",
  ].join("\n");
  const g = hlsl2glsl(src, "frag", {}, () => null);
  if (!/vec3 lightMap = vec3\(0\.0\), emitters;/.test(g)) {
    wireErrors.push("#define 之前的同名标识符不得被宏替换（C 预处理器语义：宏只向后生效）");
  }
  if (!/lightMap \* 1\.0/.test(g)) {
    wireErrors.push("#define 之后的引用仍须正常展开（不能因位置检查而整体失效）");
  }
}

// [we-scene patch] **varying 类型跨 stage 不一致的两个方向都要处理**。
// 既有逻辑只做「顶点更宽 → 加宽片元」；constellation 是反过来（vert vec2 /
// frag vec4），audio_buffer_accumulation 的 v_AccumulationRate 同理（vec2 / vec3）。
// 链接期报 `Types of varying 'x' differ between VERTEX and FRAGMENT shaders`，
// 整个 pass 被跳过（6 壁纸）。收窄安全：顶点没写的分量本来就是未定义值。
{
  const vert = "varying vec2 v_TexCoord;\nvoid main(){ v_TexCoord = vec2(0.0); gl_Position = vec4(0.0); }";
  const frag = [
    "varying vec4 v_TexCoord;",
    "uniform sampler2D g_Texture0;",
    "void main(){ gl_FragColor = texSample2D(g_Texture0, v_TexCoord.xy); }",
  ].join("\n");
  const g = hlsl2glsl(frag, "frag", {}, () => null, vert);
  if (!/^in vec2 v_TexCoord;/m.test(g)) {
    wireErrors.push("片元 varying 比顶点宽时必须收窄到顶点类型（否则链接期 varying types differ）");
  }
  // 片元真的读了超出顶点宽度的分量时不得收窄（作者语义如此，留给真实编译暴露）
  const frag2 = [
    "varying vec4 v_TexCoord;",
    "void main(){ gl_FragColor = vec4(v_TexCoord.zw, 0.0, 1.0); }",
  ].join("\n");
  const g2 = hlsl2glsl(frag2, "frag", {}, () => null, vert);
  if (/^in vec2 v_TexCoord;/m.test(g2)) {
    wireErrors.push("片元读了超出顶点宽度的分量时不得收窄（会把编译错误变成静默算错）");
  }
  // 反方向（顶点更宽 → 加宽片元）必须照旧工作
  const vertWide = "varying vec4 v_T;\nvoid main(){ v_T = vec4(0.0); gl_Position = vec4(0.0); }";
  const fragNarrow = "varying vec2 v_T;\nvoid main(){ gl_FragColor = vec4(v_T, 0.0, 1.0); }";
  const g3 = hlsl2glsl(fragNarrow, "frag", {}, () => null, vertWide);
  if (!/^in vec4 v_T;/m.test(g3)) {
    wireErrors.push("顶点 varying 更宽时仍须加宽片元声明（既有能力不得回归）");
  }
}

// [we-scene patch] **max/min 标量广播：第二参含运算时也要补**。
// `v_Transforms.zw = max(1e-6, u_scale * g_Texture0Resolution.xy / 3.0);`
// （procedural_noise / lens_distortion / frame_builder，5 pass / 4 壁纸）。
// 既有那条要求第二参是纯 swizzle 标识符，含运算就漏掉 → `dimension mismatch`。
// 宽度从赋值左侧的 swizzle 读（.zw → 2），比推断右侧表达式宽度可靠。
{
  const g = hlsl2glsl(
    "uniform float u_scale;\nuniform vec4 g_Texture0Resolution;\nvarying vec4 v_Transforms;\nvoid main(){ v_Transforms.zw = max(1e-6, u_scale * g_Texture0Resolution.xy / 3.0); gl_Position=vec4(0.0); }",
    "vert",
    {},
    () => null,
  );
  if (!/max\(vec2\(1e-6\),/.test(g)) {
    wireErrors.push("max/min 的标量首参必须按左侧 swizzle 宽度广播（含运算的第二参也要覆盖）");
  }
  // 同宽 / 标量赋值不得被包
  const safe = [
    ["同宽 vec2", "uniform vec2 a,b;\nvarying vec4 v;\nvoid main(){ v.zw = max(a, b); gl_Position=vec4(0.0); }", /max\(a, b\)/],
    ["标量赋标量", "uniform float a;\nvarying vec4 v;\nvoid main(){ v.z = max(0.5, a); gl_Position=vec4(0.0); }", /max\(0\.5, a\)/],
  ];
  for (const [label, src, want] of safe) {
    const s2 = hlsl2glsl(src, "vert", {}, () => null);
    if (!want.test(s2)) wireErrors.push(`max/min 同宽或标量场景不得被广播包裹（${label}）`);
  }
}

// [we-scene patch] **宏名撞上作者的同名变量声明**：只保护声明那一行。
// 内置 common_blending.h 有 `#define LUMINANCE_FACTOR vec3(0.11, 0.59, 0.3)`，
// tone_mapping.frag 自己写 `const vec3 LUMINANCE_FACTOR = vec3(0.2126, …);`。
// 不保护声明行 → `const vec3 vec3(0.11, …) = …` → `'vec3' : syntax error`，
// 整个色调映射 pass 被跳过（5 pass / 5 壁纸）。
// 也不能让宏整体失效：公共头里那些引用在作者声明**之前**，会变成
// `undeclared identifier`（GLSL 要求先声明后使用）。
{
  const src = [
    "#define LUMA vec3(0.11, 0.59, 0.3)",
    "float greyscale(vec3 c) { return dot(LUMA, c); }",
    "const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);",
    "void main() { gl_FragColor = vec4(greyscale(vec3(1.0))); }",
  ].join("\n");
  const g = hlsl2glsl(src, "frag", {}, () => null);
  if (!/const vec3 LUMA = vec3\(0\.2126/.test(g)) {
    wireErrors.push("宏名撞同名变量声明时，声明那一行不得被宏替换（会变成 vec3 vec3(...) 语法错误）");
  }
  // 声明之前的引用仍须展开成宏值，否则 undeclared identifier
  if (!/dot\(vec3\(0\.11/.test(g)) {
    wireErrors.push("作者声明之前的引用仍须展开宏值（宏整体失效会导致 undeclared identifier）");
  }
}

// [we-scene patch] **显式 vecN(...) 构造赋给更窄的向量声明**：
// `vec3 finalColor = vec4(rValue.r, gValue.g, bValue.b, 0.1);`
// （chromatic_aberration，5 壁纸）—— HLSL 隐式丢掉第 4 个分量，
// GLSL ES 报 `'=' : dimension mismatch`，整个色散 pass 被跳过。
{
  const g = hlsl2glsl(
    "uniform vec4 rV,gV,bV;\nvoid main(){ vec3 finalColor = vec4(rV.r, gV.g, bV.b, 0.1); gl_FragColor=vec4(finalColor,1.0); }",
    "frag",
    {},
    () => null,
  );
  if (!/vec3 finalColor = \(vec4\([^;]*\)\)\.xyz;/.test(g)) {
    wireErrors.push("vec3 x = vec4(...) 必须截成 .xyz（GLSL ES 无隐式丢分量）");
  }
  // 同宽构造不得被包
  for (const [label, src, want] of [
    ["vec3=vec3", "void main(){ vec3 a = vec3(0.5); gl_FragColor=vec4(a,1.0); }", /vec3 a = vec3\(0\.5\);/],
    ["vec2=vec2", "void main(){ vec2 a = vec2(0.5, 0.3); gl_FragColor=vec4(a,0,1); }", /vec2 a = vec2\(0\.5, 0\.3\);/],
  ]) {
    const s2 = hlsl2glsl(src, "frag", {}, () => null);
    if (!want.test(s2)) wireErrors.push(`同宽 vecN 构造不得被截断包裹（${label}）`);
  }
}

// [we-scene patch] vec4 v_TexCoord 喂给 texture：GLSL 只要 vec2，必须 .xy。
// 2902406982 clipping_mask 两侧都是 vec4 时「加宽」路径不触发，编不过 →
// 效果跳过 → 白三角直出（「窗口 Box」白块）。
{
  const clipSrc = [
    "varying vec4 v_TexCoord;",
    "uniform sampler2D g_Texture0;",
    "uniform sampler2D g_Texture1;",
    "uniform vec2 u_textureScale;",
    "void main() {",
    "  vec4 albedo = texSample2D(g_Texture0, v_TexCoord);",
    "  vec2 uvTex = ((v_TexCoord * 2.0 - 1.0) / u_textureScale);",
    "  vec4 clip = texSample2D(g_Texture1, v_TexCoord + uvTex);",
    "  gl_FragColor = albedo;",
    "}",
  ].join("\n");
  const clipVert = [
    "attribute vec2 a_TexCoord;",
    "varying vec4 v_TexCoord;",
    "void main() { v_TexCoord.xy = a_TexCoord; gl_Position = vec4(0.); }",
  ].join("\n");
  const glsl = hlsl2glsl(clipSrc, "frag", {}, () => null, clipVert);
  if (/texture\s*\(\s*g_Texture0\s*,\s*v_TexCoord\s*\)/.test(glsl)) {
    wireErrors.push("texture(sampler, vec4 v_TexCoord) 必须截成 .xy");
  }
  if (!/texture\s*\(\s*g_Texture0\s*,\s*v_TexCoord\.xy\s*\)/.test(glsl)) {
    wireErrors.push("texture 的 vec4 UV 应改写为 v_TexCoord.xy");
  }
  if (/vec2\s+uvTex\s*=\s*\(\(\s*v_TexCoord\s*\*/.test(glsl)) {
    wireErrors.push("vec2 赋值里的裸 vec4 v_TexCoord 必须 .xy");
  }
  if (!/texture\s*\(\s*g_Texture1\s*,\s*\(\s*v_TexCoord\.xy\s*\+/.test(glsl)) {
    wireErrors.push("texture(s, v_TexCoord + offset) 必须把左侧截成 .xy");
  }
  const hlslSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hlsl2glsl.js"), "utf8");
  if (!/vec4\/vec3 当 UV 用/.test(hlslSrc)) {
    wireErrors.push("hlsl2glsl.js 必须包含 vec4/vec3 UV 截断");
  }
  const clipPkg = join(LIB, "2902406982", "scene.pkg");
  if (fs.existsSync(clipPkg)) {
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(clipPkg)); } catch { pkg = null; }
    const frag = pkg && getEntry(pkg, "shaders/workshop/2800594362/effects/clipping_mask.frag");
    const vert = pkg && getEntry(pkg, "shaders/workshop/2800594362/effects/clipping_mask.vert");
    if (!frag) {
      wireErrors.push("2902406982 必须含 clipping_mask.frag");
    } else {
      const glsl2 = hlsl2glsl(
        readText(frag),
        "frag",
        { BLENDMODE: 5, CLIPCOLOR: 0, INVERT: 0, PARALLAX: 0, ALIGNMENT: 0, MASK: 1 },
        makeResolver(pkg),
        vert ? readText(vert) : "",
      );
      if (/texture\s*\(\s*g_Texture0\s*,\s*v_TexCoord\s*\)/.test(glsl2)) {
        wireErrors.push("2902406982 clipping_mask 的 texture UV 必须 .xy");
      }
      if (/vec2\s+uvTex\s*=\s*\(\(\s*v_TexCoord\s*\*/.test(glsl2)) {
        wireErrors.push("2902406982 clipping_mask 的 uvTex 必须用 v_TexCoord.xy");
      }
    }
  }
}

// [we-scene patch] 已声明 float 赋裸整数 + 标量→向量广播。
// 3789816832 Sound：Simple_Audio_Bars.vert `i_DCorrectingFactor = 1`、sine_wave
// `waveCoord = pow(...); ApplyBlending(..., opacity * waveCoord)` —— GLSL ES 无
// int→float / float→vec2 隐式转换，整段音谱 pass 被跳过，诊断「alpha 无信息」。
{
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/hlsl2glsl.js"), "utf8");
  if (!/已声明的 float 标识符/.test(src)) {
    wireErrors.push("hlsl2glsl.js 必须改写「已声明 float = 裸整数」");
  }
  if (!/标量 → 向量广播/.test(src)) {
    wireErrors.push("hlsl2glsl.js 必须包含标量→向量广播");
  }
  const vertOut = hlsl2glsl(
    "varying float i_DCorrectingFactor;\nvoid main() { i_DCorrectingFactor = 1; }",
    "vert",
    {},
    () => null,
    "",
  );
  if (!/i_DCorrectingFactor\s*=\s*1\.0\s*;/.test(vertOut)) {
    wireErrors.push("out/varying float = 1 必须写成 1.0");
  }
  if (/\bi_DCorrectingFactor\s*=\s*1\s*;/.test(vertOut)) {
    wireErrors.push("故意保留 int 赋值会让 Simple_Audio_Bars 整 pass 编不过");
  }
  const sineOut = hlsl2glsl(
    [
      "varying vec2 v_TexCoord;",
      "uniform float u_WaveOpacity;",
      "uniform vec3 u_WaveColor;",
      "vec3 ApplyBlending(int mode, vec3 A, vec3 B, float opacity) { return mix(A, B, opacity); }",
      "void main() {",
      "  vec2 waveCoord = v_TexCoord;",
      "  waveCoord = pow(0.5, 2.0);",
      "  vec3 finalColor = ApplyBlending(0, vec3(1.0), u_WaveColor, u_WaveOpacity * waveCoord);",
      "  gl_FragColor = vec4(finalColor, 1.0);",
      "}",
    ].join("\n"),
    "frag",
    {},
    () => null,
    "",
  );
  if (!/waveCoord\s*=\s*vec2\s*\(/.test(sineOut)) {
    wireErrors.push("vec2 = pow(...) 必须广播为 vec2(pow(...))");
  }
  if (!/u_WaveOpacity\s*\*\s*waveCoord\.x/.test(sineOut)) {
    wireErrors.push("float * 标量填充的 vec 必须取 .x 才能喂 ApplyBlending");
  }
  const barsPkg = join(LIB, "3789816832", "scene.pkg");
  if (fs.existsSync(barsPkg)) {
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(barsPkg)); } catch { pkg = null; }
    const frag = pkg && getEntry(pkg, "shaders/workshop/3577773857/effects/Simple_Audio_Bars.frag");
    const vert = pkg && getEntry(pkg, "shaders/workshop/3577773857/effects/Simple_Audio_Bars.vert");
    if (!frag || !vert) {
      wireErrors.push("3789816832 必须含 workshop/3577773857 Simple_Audio_Bars");
    } else {
      const vGlsl = hlsl2glsl(readText(vert), "vert", { ANTIALIAS: 0, RESOLUTION: 16, SHAPE: 7 }, makeResolver(pkg), readText(frag));
      if (/\bi_DCorrectingFactor\s*=\s*1\s*;/.test(vGlsl)) {
        wireErrors.push("3789816832 Simple_Audio_Bars.vert 不得残留 int 赋值");
      }
      if (!/\bi_DCorrectingFactor\s*=\s*1\.0\s*;/.test(vGlsl)) {
        wireErrors.push("3789816832 Simple_Audio_Bars.vert 必须把 = 1 写成 = 1.0");
      }
      const sineFrag = getEntry(pkg, "shaders/workshop/3577773857/effects/sine_wave.frag");
      const sineVert = getEntry(pkg, "shaders/workshop/3577773857/effects/sine_wave.vert");
      if (sineFrag) {
        const sGlsl = hlsl2glsl(
          readText(sineFrag),
          "frag",
          {},
          makeResolver(pkg),
          sineVert ? readText(sineVert) : "",
        );
        if (/u_WaveOpacity\s*\*\s*waveCoord\b(?!\s*\.)/.test(sGlsl)) {
          wireErrors.push("3789816832 sine_wave 的 opacity*waveCoord 必须是 *waveCoord.x");
        }
      }
      // 2902406982 的 vec2 赋值 .xy 改写若扫到公共头 `vec3 r;`，会把 Bars 的
      // `float r; vec2 delta = … + r` 改成 `r.xy` → 音谱回归消失。
      const fGlsl = hlsl2glsl(readText(frag), "frag", {}, makeResolver(pkg), readText(vert));
      if (/vec2\s+delta\s*=[^;]*\br\.xy\b/.test(fGlsl)) {
        wireErrors.push("3789816832 Simple_Audio_Bars 不得把 float r 改成 r.xy（公共头 vec3 r 误伤）");
      }
      if (!/vec2\s+delta\s*=[^;]*\+\s*r\s*;/.test(fGlsl)) {
        wireErrors.push("3789816832 Simple_Audio_Bars 的 delta 必须保留标量 r");
      }
    }
  }
  // 迷你语料：公共头风格的 vec3 r 不得污染其它函数里的 float r
  {
    const mini = hlsl2glsl(
      [
        "varying vec2 v_TexCoord;",
        "vec3 ApplyBlending(int mode, vec3 A, vec3 B, float opacity) { vec3 r; r = A; return r; }",
        "float roundedHollowBoxSDF(vec2 CurPosition, vec3 Size) {",
        "  float r = min(Size.x, Size.y);",
        "  vec2 delta = abs(CurPosition) - (Size.xy) + r;",
        "  return length(max(delta, 0.0)) - r;",
        "}",
        "void main() { gl_FragColor = vec4(roundedHollowBoxSDF(v_TexCoord, vec3(1.0))); }",
      ].join("\n"),
      "frag",
      {},
      () => null,
      "",
    );
    if (/\br\.xy\b/.test(mini)) {
      wireErrors.push("vec2 赋值 .xy 改写不得误伤 float r（ApplyBlending 的 vec3 r）");
    }
  }
  // 3264246690 scroll.vert：`scroll = sign(scroll) * pow(vec2(...), …)` 以 sign( 开头
  // 但整式是 vec2。9b 若只看前缀会误标 scalarFilled，把 `scroll * g_Time` 改成
  // `scroll.x * g_Time` → 胶带静止。迷你语料 + 真包双断言。
  const scrollMini = hlsl2glsl(
    [
      "uniform float g_Time;",
      "uniform float g_ScrollX;",
      "uniform float g_ScrollY;",
      "varying vec2 v_Scroll;",
      "void main() {",
      "  vec2 scroll = vec2(g_ScrollX, g_ScrollY);",
      "  scroll = sign(scroll) * pow(vec2(g_ScrollX, g_ScrollY), vec2(2.0));",
      "  v_Scroll = scroll * g_Time;",
      "}",
    ].join("\n"),
    "vert",
    {},
    () => null,
    "",
  );
  if (/scroll\.x\s*\*\s*g_Time/.test(scrollMini)) {
    wireErrors.push("scroll = sign(scroll)*pow(vec2…) 不得被标成 scalarFilled（会变成 scroll.x*g_Time）");
  }
  if (!/v_Scroll(?:_rw)?\s*=\s*scroll\s*\*\s*g_Time/.test(scrollMini)) {
    wireErrors.push("scroll * g_Time 必须保持 vec2*float（DANGER 胶带滚动）");
  }
  const tapePkg = join(LIB, "3264246690", "scene.pkg");
  if (fs.existsSync(tapePkg)) {
    let pkg;
    try { pkg = parsePkg(fs.readFileSync(tapePkg)); } catch { pkg = null; }
    const sVert = pkg && getEntry(pkg, "shaders/effects/scroll.vert");
    const sFrag = pkg && getEntry(pkg, "shaders/effects/scroll.frag");
    if (!sVert) {
      wireErrors.push("3264246690 必须含 shaders/effects/scroll.vert");
    } else {
      const g = hlsl2glsl(readText(sVert), "vert", {}, makeResolver(pkg), sFrag ? readText(sFrag) : "");
      if (/scroll\.x\s*\*\s*g_Time/.test(g)) {
        wireErrors.push("3264246690 scroll.vert 不得把 scroll*g_Time 收成 scroll.x");
      }
    }
  }
}
if (wireErrors.length) {
  console.log(`\n[图层材质/音谱转译] ${wireErrors.length} 处`);
  for (const e of wireErrors) console.log("    " + e);
}

const bad = includeMissing.size + undefAgg.size + macroAgg.size + leftoverAgg.size + structAgg.length + wireErrors.length;
if (listUndefined) process.exit(0);
if (bad === 0) {
  console.log("\n全部通过");
  process.exit(0);
}
console.log(`\n发现 ${bad} 类问题`);
process.exit(1);
