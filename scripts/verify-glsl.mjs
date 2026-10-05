#!/usr/bin/env node
/**
 * verify-glsl —— 转译产物的**真编译**校验 + 报错驱动修复（glsl-repair.js）契约。
 *
 *   node scripts/verify-glsl.mjs          单元用例 + 全库编译
 *   node scripts/verify-glsl.mjs --quick  只跑单元用例
 *
 * 1) 单元用例：每类 HLSL 隐式规则一个最小 shader，断言修复后能编译、且修法符合
 *    HLSL 语义（向量按窄侧截断而不是取首分量、全局 const 挪进 main 等）。
 * 2) 全库：本地壁纸库所有 pkg 里的 shader 逐个 hlsl2glsl → glslang 编译，失败的
 *    走 repairGlsl，断言**修复后零失败**（修复前的失败数只打印，作为转译器长尾的观测量）。
 *
 * 需要 glslangValidator（brew install glslang）；没有就整体跳过（退出码 0），
 * 壁纸库不存在时跳过第 2 部分。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import { LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";

if (spawnSync("glslangValidator", ["--version"]).status !== 0) {
  console.log("跳过：未找到 glslangValidator");
  process.exit(0);
}

const { repairGlsl, parseInfoLog } = await imp("renderer/vendor/we-scene/render/glsl-repair.js");
const { check, errors } = createChecker();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-glsl-"));
const glc = (stage, src) => {
  const f = path.join(tmp, "s." + stage);
  fs.writeFileSync(f, src);
  try {
    execFileSync("glslangValidator", [f], { stdio: "pipe" });
    return [];
  } catch (x) {
    return parseInfoLog(String(x.stdout));
  }
};

const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\n";
const FS = (body, globals = "") =>
  `${HEAD}uniform float u_f; uniform vec2 u_v2; uniform vec3 u_v3; uniform vec4 u_v4;\n${globals}\nout vec4 o;\nvoid main() {\n${body}\n}\n`;

const CASES = [
  ["vec2 - vec4 → 宽侧截断", FS("vec2 a = u_v2 - (u_f * u_v4); o = vec4(a, 0.0, 1.0);"), /\)\.xy/],
  ["int 字面量 + 向量", FS("float a = (1 + u_v2 * 2.0).x; o = vec4(a);"), /float\(1\)/],
  ["max(int, float)", FS("int k = 1; float a = max(k, u_f); o = vec4(a);"), /max\(float\(k\)/],
  ["mix 第三参 vec4 → .xyz", FS("vec3 c = mix(u_v3, u_v3, u_v4); o = vec4(c, 1.0);"), /\(u_v4\)\.xyz/],
  ["float % float → mod", FS("float a = u_f % 1.0; o = vec4(a);"), /mod\(/],
  ["int % float → int()", FS("int i = 3; int j = i % float(4); o = vec4(float(j));"), /i % int\(/],
  ["float 当 bool", FS("float a = 0.0; if (u_f) a = 1.0; o = vec4(a);"), /if \(bool\(u_f\)\)/],
  ["三元条件是 float", FS("vec4 c = vec4(u_f ? u_v4 : u_v4.wzyx); o = c;"), /bool\(u_f\)/],
  ["vec4 赋给 float → .x", FS("float r = step(1.0, u_v4); o = vec4(r);"), /\(step\(1\.0, u_v4\)\)\.x/],
  ["float 赋给 int", FS("int m = 1.0; o = vec4(float(m));"), /int\(1\.0\)/],
  ["多声明初值广播", FS("vec2 a = 0.0, b = 0.0; o = vec4(a, b);"), /vec2\(0\.0\), b = vec2\(0\.0\)/],
  ["全局 const 用 uniform", FS("o = vec4(K);", "const float K = u_f * 0.5;"), /void main\(\) \{ K = u_f \* 0\.5;/],
  ["return 类型", `${HEAD}float f() { return 0; }\nout vec4 o;\nvoid main() { o = vec4(f()); }\n`, /return float\(0\)/],
  [
    "自定义函数按签名转实参（同行多处）",
    `${HEAD}uniform vec2 u_v2;\nvec3 ts(int x, int y, vec2 c) { return vec3(float(x + y), c); }\nout vec4 o;\nvoid main() {\nfloat l = length(ts(-1.0, 0.0, u_v2)); l += length(ts(1.0, 1.0, u_v2));\no = vec4(l);\n}\n`,
    /ts\(int\(-1\.0\),int\( 0\.0\)|ts\(int\(-1\.0\), int\(0\.0\)/,
  ],
  ["声明里多余的 swizzle", `${HEAD}in vec4 v_S.xy;\nout vec4 o;\nvoid main() { o = v_S; }\n`, /in vec4 v_S;/],
];

for (const [name, src, expect] of CASES) {
  const before = glc("frag", src);
  check(before.length > 0, `${name}：用例本身应编译失败（否则测不到修复）`);
  const r = repairGlsl(src, (s) => glc("frag", s));
  check(r.ok, `${name}：修复后应能编译 —— ${r.errors.map((e) => e.msg).join(" | ")}`);
  if (r.ok) check(expect.test(r.src), `${name}：修法不符合预期 ${expect}\n${r.src}`);
}

// 能编译的 shader 不得被改动
{
  const ok = FS("o = u_v4;");
  const r = repairGlsl(ok, (s) => glc("frag", s));
  check(r.ok && r.src === ok && r.fixes === 0, "已能编译的 shader 不应被改写");
}
console.log(`单元用例：${CASES.length + 1} 项，失败 ${errors.length}`);

if (!process.argv.includes("--quick") && fs.existsSync(LIB)) {
  const { hlsl2glsl } = await imp("renderer/vendor/we-scene/render/hlsl2glsl.js");
  const { WE_SHADER_HEADERS } = await imp("renderer/vendor/we-scene/headers.ts");
  const { WE_BUILTIN_SHADERS } = await imp("renderer/vendor/we-scene/shaders-builtin.ts");
  const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
  const txt = (b) => dec.decode(b).replace(/^\uFEFF/, "");
  const seen = new Set();
  let units = 0;
  let rawFail = 0;
  const left = [];
  for (const id of fs.readdirSync(LIB)) {
    const p = path.join(LIB, id, "scene.pkg");
    if (!fs.existsSync(p)) continue;
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(p)));
    const res = (f) => {
      const e = getEntry(pkg, "shaders/" + f);
      return e ? txt(e) : (WE_SHADER_HEADERS[f] ?? WE_BUILTIN_SHADERS[f] ?? null);
    };
    for (const e of pkg.entries) {
      if (!/\.frag$/.test(e.name)) continue;
      const frag = txt(getEntry(pkg, e.name));
      const ve = getEntry(pkg, e.name.replace(/\.frag$/, ".vert"));
      const vert = ve ? txt(ve) : "";
      for (const [stage, src, sib] of [["frag", frag, vert], ["vert", vert, frag]]) {
        if (!src) continue;
        const key = stage + ":" + src;
        if (seen.has(key)) continue;
        seen.add(key);
        units++;
        let out;
        try {
          out = hlsl2glsl(src, stage, {}, res, sib);
        } catch (x) {
          left.push(`${id} ${e.name} ${stage}: 转译异常 ${x.message}`);
          continue;
        }
        if (!/^\s*#version/.test(out)) out = HEAD + out;
        if (glc(stage, out).length === 0) continue;
        rawFail++;
        const r = repairGlsl(out, (s) => glc(stage, s));
        if (!r.ok) left.push(`${id} ${e.name} ${stage}: ${r.errors[0]?.line}: ${r.errors[0]?.msg}`);
      }
    }
  }
  console.log(`全库：${units} 个唯一 shader，转译后直接编译失败 ${rawFail}，修复后仍失败 ${left.length}`);
  for (const l of left) console.log("  ✗ " + l);
  check(left.length === 0, `修复后仍有 ${left.length} 个 shader 编译失败`);
} else if (!process.argv.includes("--quick")) {
  console.log("跳过全库：壁纸库不存在 " + LIB);
}

fs.rmSync(tmp, { recursive: true, force: true });
if (errors.length) {
  for (const e of errors) console.log("✗ " + e);
  process.exit(1);
}
console.log("verify-glsl 通过");
