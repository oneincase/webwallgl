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
