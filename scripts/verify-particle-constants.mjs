#!/usr/bin/env node
/**
 * verify-particle-constants —— 粒子子系统的**常量与缺省值**契约（W4）。
 *
 * 这些数字决定「素材里一个字段能让我们分配多少内存」，是本仓最靠近 DoS 的一层，
 * 却长期散落在 `particles.js` / `particle-shaders.js` / `pkg/limits.js` 三处、没有判据。
 * 本脚本把它们钉成文本（哪一行、什么公式）+ 行为（纯函数真的返回什么）两层，
 * 任何一处被静默放宽都会在这里变红。
 *
 * 凭什么取这些值：见 `docs/re/we-native-particle-constants.md`（证据表）。
 * 三层来源要分清，改任何一条前先看那一层：
 *   ① **闸门**（`pkg/limits.js`）—— 只为「算得出来」兜底，不承诺与播放器同值；
 *   ② **本仓预算**（`MAX_POOL_BY_QUALITY` / `COUNT_RATE_MUL_CAP` / `PARTICLE_*_CAP`）
 *      —— 我们自己画的质量档，**不是**素材语义；
 *   ③ **素材语义缺省**（rate/lifetime/size/alpha/velocity/rotation/renderer）
 *      —— 字段缺席时引擎该当作什么，这一层错会让整张壁纸看起来不对。
 *
 * 纪律：
 *   · 只跑 `node scripts/verify-particle-constants.mjs`（单跑，不注册进 verify-all）；
 *   · 动态导入段不碰 GL：`particles.js` 的纯函数（时序/绳长/段数）在裸 node 下可执行。
 */
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const R = join(ROOT, "renderer/vendor/we-scene/render/");
const PKG = join(ROOT, "renderer/vendor/we-scene/pkg/");
const PP = join(ROOT, "editor/particle-params.ts");

// 变异红测用：esbuild 把编辑器的 TS 就地打成 mjs，覆盖只在内存里生效，绝不落盘。
const tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "verify-particle-params-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const PP_ENTRY = `export * from "./editor/particle-params.ts";\nexport { particleComponents as componentRegistry, BUILTIN_PARTICLE_COMPONENTS } from "./editor/particles.ts";\n`;

/** 打 editor/particle-params.ts（连带 ./particles 的注册表）成临时 mjs；overrides 按绝对路径换源码 */
async function loadParticleParams(overrides = {}) {
  const plugins = Object.keys(overrides).length
    ? [
        {
          name: "mutate",
          setup(b) {
            b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined));
          },
        },
      ]
    : [];
  const out = await build({
    stdin: { contents: PP_ENTRY, resolveDir: ROOT, loader: "ts", sourcefile: "pp-entry.ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = join(tmpRoot, `pp-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const readP = (f) => fs.readFileSync(join(R, f), "utf8");
const readPkg = (f) => fs.readFileSync(join(PKG, f), "utf8");
const count = (hay, re) => (hay.match(re) || []).length;
const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

console.log("\n[1] sequencemultiplier：解析期闸门 + 帧表分配上限（两层，缺一不可）");
{
  const limits = stripComments(readPkg("limits.js"));
  const p = stripComments(readP("particles.js"));
  check(/export const MAX_SEQUENCE_MUL = 4096/.test(limits), "pkg/limits.js 必须导出 MAX_SEQUENCE_MUL = 4096（解析闸门）");
  const clampCtor = /this\.sequenceMul = Math\.max\(1, Math\.min\(MAX_SEQUENCE_MUL, Math\.round\(num\(this\.model\.sequencemultiplier, 1\)\)\)\)/;
  const clampHot = /this\.sequenceMul = Math\.max\(1, Math\.min\(MAX_SEQUENCE_MUL, Math\.round\(num\(model\.sequencemultiplier, 1\)\)\)\)/;
  check(
    clampCtor.test(p) && clampHot.test(p),
    "sequenceMul 的 clamp 必须同时出现在构造与热更路径（漏一处，热更新素材就能绕过闸门）",
  );
  check(/this\.frameCount = this\.sequenceMul \* this\.sequenceMul/.test(p), "frameCount 恒为 N²（无 TEXS 帧表时）");
  // 帧表分配必须在**分配前**封顶：frameCap 出现在双重循环条件里，而不是只用于事后截断。
  check(
    /const frameCap = 128[\s\S]{0,220}?for \(let r = 0; r < n && list\.length < frameCap; r\+\+\)[\s\S]{0,120}?for \(let c = 0; c < n && list\.length < frameCap; c\+\+\)/.test(p),
    "N×N 帧表必须**在循环条件里**用 frameCap = 128 封顶（N=100000 时事后截断会先造出 1e10 个对象）",
  );
  const sh = stripComments(readP("particle-shaders.js"));
  check(/uniform vec4 u_frames\[128\]/.test(sh), "shader 侧 u_frames 容量必须与 frameCap 一致（128）");
}

console.log("\n[2] 实例/发射预算上限（本仓预算层，非素材语义）");
{
  const p = stripComments(readP("particles.js"));
  check(/const MAX_POOL_BY_QUALITY = \{ low: 3000, medium: 6000, high: 12000 \}/.test(p), "质量档池上限 3000 / 6000 / 12000");
  check(/const COUNT_RATE_MUL_CAP = \{ low: 3, medium: 5, high: 8 \}/.test(p), "质量档 rate 放大上限 3 / 5 / 8");
  const maxCount = /this\.maxCount = Math\.max\(1, Math\.min\(20000, num\(this\.model\.maxcount, 100\) \* particleQualityScale\)\)/g;
  check(count(p, maxCount) === 2, `maxCount 必须 = clamp(素材 maxcount × 质量倍率, 1, 20000)，缺省素材值 100，且构造/热更两条路径同式（实得 ${count(p, maxCount)} 处）`);
  check(/const PARTICLE_FILL_CAP = 2048/.test(p), "fill 型发射器封顶 2048（缺省素材 maxcount=100 会把它顶到 100，显式写大才会碰上这个盖子）");
  check(/const PARTICLE_STEP_BUDGET = 240_000/.test(p), "每帧步进预算 240k，用于反推 stepsByBudget");
}

console.log("\n[3] 事件（children eventspawn/eventdeath）队列上限");
{
  const p = stripComments(readP("particles.js"));
  check(/const EVENT_BOUND_CAP = 256/.test(p), "单次事件可派生的粒子绑定上限 256");
  check(/const EVENT_BURST_QUEUE_CAP = 64/.test(p), "爆发事件队列上限 64（超出的按 FIFO shift 丢弃）");
}

console.log("\n[4] 素材语义缺省值（字段缺席时的行为，错一层整张壁纸就不一样）");
{
  const p = stripComments(readP("particles.js"));
  check(/rate: num\(e\.rate, 0\)/.test(p), "emitter.rate 缺省 0（配合 instantaneous 才是爆发）");
  check(
    /fill: e\.rate === undefined && e\.instantaneous === undefined && e\.audioprocessingmode === undefined/.test(p),
    "fill 型发射器判据 = rate/instantaneous/audioprocessingmode **三者都没有**（旧行为只看 rate，会误判爆发型）",
  );
  check(/this\.init\.life = \{ min: num\(z\.min, 1\), max: num\(z\.max, 1\), exp: num\(z\.exponent, 1\) \}/.test(p), "lifetimerandom 缺省 min=max=1 秒");
  check(/this\.init\.size = \{ min: num\(z\.min, 1\), max: num\(z\.max, 1\), exp: num\(z\.exponent, 1\) \}/.test(p), "sizerandom 缺省 min=max=1");
  check(/this\.init\.alpha = \{ min: num\(z\.min, 1\), max: num\(z\.max, 1\) \}/.test(p), "alpharandom 缺省 min=max=1");
  check(
    /p\.life = I\.life \? Math\.max\(0\.001, randExp\(I\.life\.min, I\.life\.max, I\.life\.exp\) \* this\.lifetimeMul\) : 1/.test(p),
    "无 life 初始化器时粒子寿命缺省 1 秒",
  );
  check(/p\.baseSize = I\.size \? randExp\([^)]*\) \* sizeMul : 20 \* sizeMul/.test(p), "无 size 初始化器时粒径缺省 20px");
  check(/p\.baseAlpha = \(I\.alpha \? rand\(I\.alpha\.min, I\.alpha\.max\) : 1\) \* this\.opacityMul/.test(p), "无 alpha 初始化器时透明度缺省 1");
  check(/\|\| \[-32, -32, 0\]/.test(p) && /\|\| \[32, 32, 0\]/.test(p), "velocityrandom 缺省 ±32（z 恒 0）");
  check(/\|\| \[0, 0, TAU\]/.test(p), "rotationrandom 缺省绕 z 一圈（TAU）");
  check(/\|\| \[0, 0, -5\]/.test(p) && /\|\| \[0, 0, 5\]/.test(p), "angularvelocityrandom 缺省 z 向 ±5");
  check(/audioBounds: parseVec\(e\.audioprocessingbounds, \[0\.8, 1\.0\]\)/.test(p), "发射器 audioprocessingbounds 缺省 [0.8, 1.0]");
  check(/scale: num\(z\.scale, 0\.1\)/.test(p), "turbulentvelocity 缺省 scale 0.1");
}

console.log("\n[5] renderer 缺省（sprite / spritetrail / rope / ropetrail）");
{
  const p = stripComments(readP("particles.js"));
  check(
    /length: num\(r && r\.length, kind === 'spritetrail' \? 0\.1 : kind === 'ropetrail' \? 0\.2 : 0\)/.test(p),
    "renderer 长度缺省：spritetrail 0.1 / ropetrail 0.2 / 其余 0",
  );
  check(/maxLength: num\(r && r\.maxlength, kind === 'ropetrail' \? 10 : 0\)/.test(p), "maxlength 缺省：ropetrail 10 / 其余 0（0 会让 quad 退化）");
  check(/subdivision: num\(r && r\.subdivision, 1\)/.test(p), "subdivision 缺省 1（0 会产生除零风险）");
  check(/segments: num\(r && r\.segments, 0\)/.test(p), "segments 缺省 0");
}

console.log("\n[6] 实例布局（每帧上传缓冲的固定步长与属性槽）");
{
  const p = stripComments(readP("particles.js"));
  const sh = stripComments(readP("particle-shaders.js"));
  check(/const STRIDE = 18/.test(p), "实例流 STEP 恒为 18 float：pos3 + size1 + rot1 + color4 + frame1 + aspect2 + vrange2 + frameB/mix2 + rotXY2");
  check(/const STRIDE = 13/.test(p), "材质 shader 顶点流恒为 13 float/顶点（a_Position3 + a_TexCoordVec4 4 + a_Color4 + a_TexCoordC2 2）");
  for (const [loc, name, type] of [
    [0, "a_corner", "vec2"],
    [1, "a_pos", "vec3"],
    [2, "a_sizeRot", "vec2"],
    [3, "a_color", "vec4"],
    [4, "a_stretchFrame", "vec3"],
    [5, "a_vrange", "vec2"],
    [6, "a_frameBlend", "vec4"],
  ]) {
    check(new RegExp(`layout\\(location=${loc}\\) in ${type} ${name}`).test(sh), `属性槽 ${loc} = ${name} (${type})`);
  }
  check(/uniform float u_refractScale/.test(sh), "折射标量 u_refractScale 存在（缺省 0.05，范围 [-1,1]）");
}

console.log("\n[7] 纯函数行为（裸 node 动态导入，真跑一遍）");
{
  const particles = await import(pathToFileURL(join(R, "particles.js")).href);
  const limits = await import(pathToFileURL(join(PKG, "limits.js")).href);
  const t = particles.compileEmitterTiming;
  check(limits.MAX_SEQUENCE_MUL === 4096, "MAX_SEQUENCE_MUL === 4096");
  check(t({}).periodic === null, "compileEmitterTiming({}) → periodic = null（非周期）");
  check(t({ flags: 4 }).periodic !== null, "flags bit2(4) → periodic 对象存在（周期发射）");
  check(
    t({ flags: 4 }).periodic.durMin === 0 &&
      t({ flags: 4 }).periodic.durMax === 0 &&
      t({ flags: 4 }).periodic.gapMin === 0 &&
      t({ flags: 4 }).periodic.gapMax === 0 &&
      t({ flags: 4 }).periodic.max === 0,
    "周期分量缺省全 0（durMax/gapMax 回落到各自的 min）",
  );
  check(t({ flags: 4, minperiodicdelay: -3 }).periodic.gapMin === 0, "负的周期延迟必须夹到 0");
  check(t({ duration: -1 }).duration === 0 && t({ maxtoemitperperiod: 2.9, flags: 4 }).periodic.max === 2, "duration 下界 0、maxtoemitperperiod 向下取整");
  const hist = particles.ropeTrailHistoryCount;
  check(hist({ kind: "ropetrail", segments: 2 }) === 2, "ropetrail segments=2 → 历史帧 2");
  check(hist({ kind: "ropetrail", segments: 999 }) === 32, "ropetrail 历史帧上限 32（segments 再大也不涨）");
  check(hist({ kind: "ropetrail", segments: 0 }) === 8, "ropetrail 未给 segments → 缺省 8");
  check(hist({ kind: "sprite" }) === 1, "非 ropetrail 不采样历史（恒 1）");
  check(hist({ kind: "ropetrail", segments: 1 }) === 8, "segments=1 视为未给（缺省 8，不落成 1 帧）");
  check(particles.ropeTrailDuration({ kind: "ropetrail", length: 0 }) === 0.2, "ropetrail 无 length → 拖尾时长缺省 0.2s");
  check(particles.particleInstanceSegs({ kind: "ropetrail" }, 4) === 4, "ropetrail 实例段数 = segments");
  check(particles.particleInstanceSegs({ kind: "ropetrail" }, 0) === 1, "段数 0 必须兜到 1（否则实例缓冲长度为 0）");
  check(particles.particleInstanceSegs({ kind: "sprite" }, 4) === 1, "非 ropetrail 恒 1 份实例");
  check(particles.ropeParticleV({ age: 0.5, life: 1 }) === 0.5, "ropeParticleV = age / life");
}

console.log("\n[8] 初始化器分派表：钉住当前已知状态（标签被「插块」吃掉 ⇒ 体不可达）");
{
  const raw = readP("particles.js");
  // 本段是「故意反向」的：本仓目前确实缺这个 case 标签（d9814df 插块吞掉），
  // 而补回标签属行为变更，已另有书面决定「另立一项」，不在本 wave 范围。
  // 所以这里钉住现状；谁补回标签，本段 3 项会一起变红 —— 那时请同批更新：
  // editor/particle-params.ts 的 engineUnsupported、editor/i18n.ts 文案、
  // scripts/verify-editor.mjs 的两处断言、docs/re/we-native-particle-constants.md §2.1。
  check(
    count(raw, /case 'turbulentvelocityrandom':/g) === 0,
    "turbulentvelocityrandom 的 case 标签当前应为缺失（已确证缺陷，本轮不修）；若已补回，请同批更新上面列出的四处",
  );
  check(
    /break\s*\n\s*\/\/[^\n]*\n\s*this\.init\.turbulentVelocity = \{/.test(raw),
    "该初始化器体当前紧跟在裸 break（+注释）之后 ⇒ 无 case 标签、整块不可达（状态本身要被钉住，避免被无声改掉）",
  );
  // 通用不变量：独占一行的 `break` 之后、下一个 case/default/} 之前，不允许再出现代码行。
  const lines = raw.split("\n");
  const blankOrComment = (s) => /^\s*(\/\/.*|\*.*|\/\*.*)?\s*$/.test(s);
  const dead = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*break\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && blankOrComment(lines[j])) j++;
    const t = lines[j] || "";
    if (t.trim() && !/^\s*(case\s|default\s*:|\})/.test(t)) dead.push(`${j + 1}: ${t.trim().slice(0, 60)}`);
  }
  check(
    dead.length === 1 && /^693: this\.init\.turbulentVelocity = \{/.test(dead[0]),
    `全文不可达语句当前应恰好 1 处（应为 693: this.init.turbulentVelocity = {，实得 ${dead.length} 处${dead.length ? "：" + dead.slice(0, 3).join(" | ") : ""}）`,
  );
}

console.log("\n[9] 构造期端到端（真建一个 ParticleSystem，不需要 GL）");
{
  const { ParticleSystem } = await import(pathToFileURL(join(R, "particles.js")).href);
  const mk = (model) => new ParticleSystem(null, model);
  check(mk({}).maxCount === 100, "空模型 → maxCount = 100（素材 maxcount 缺省）");
  check(mk({ maxcount: 1e9 }).maxCount === 20000, "maxcount 1e9 → 硬上限 20000");
  check(mk({ maxcount: 0 }).maxCount === 1, "maxcount 0 → 下界 1（不会造出零容量池）");
  check(mk({}).sequenceMul === 1, "空模型 → sequenceMul = 1");
  check(mk({ sequencemultiplier: 1e9 }).sequenceMul === 4096, "sequencemultiplier 1e9 → 闸门 4096（端到端，不只看文本）");
  check(mk({ sequencemultiplier: null }).sequenceMul === 1, "sequencemultiplier: null → 1（与字段缺席同解）");
  check(mk({}).frameBlend === true, "flags 缺席 → 帧间混合开启（bit1 未置位）");
  check(mk({ flags: 2 }).frameBlend === false, "flags bit1(2) → spritenoframeblending 生效");
  check(mk({ flags: 1 }).worldSpace === true, "flags bit0(1) → 世界空间");
  const turb = mk({ maxcount: 5, emitter: [{ name: "boxrandom", rate: 10 }], initializer: [{ name: "turbulentvelocityrandom", scale: 0.3 }] });
  check(
    turb.init.turbulentVelocity === null,
    "已知缺陷的端到端表现：case 标签缺失 ⇒ 该初始化器整块死代码 ⇒ 这里应为 null（补回标签后本断言会变红，见段 [8] 注释）",
  );
  check(
    /this\.init\.turbulentVelocity = \{[^}]*scale: num\(z\.scale, 0\.1\)/.test(readP("particles.js")),
    "该初始化器体仍应带文档化的缺省 scale 0.1（体不可达 ≠ 可以消失）",
  );
}

// ── [10] D2：插件贡献的粒子组件参数（静态表未命中 → particleComponents 注册表回落） ──
// ── [11] L4：粒子文件 BOM 与序列化保真 ──
// 两段都真跑 editor/particle-params.ts（esbuild 打包成临时 mjs），不 grep 源码。

/** D2/L4 全套判据：不直接打印，变异红测复用同一份 */
async function ppSuite(P) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const reg = P.componentRegistry;
  const specStatus = (kind, name) => P.particleComponents({ [kind]: [{ name }] })[0]?.status;
  const keys = (fields) => fields.map((f) => `${f.key}:${f.type}`).join(",");

  // ── D2：静态表未命中时的回落 ──
  // 先钉住「死通道」到底有几只：引擎认识的组件里，静态表没有 spec 的**恰好**是 positionoffsetrandom
  // 一个（清单核对过：oscillatealpha / oscillateposition / oscillatesize 都早有静态 spec）。
  const staticKeys = new Set(P.PARTICLE_SPECS.map((s) => `${s.kind}:${s.name}`));
  const dead = P.BUILTIN_PARTICLE_COMPONENTS.map((c) => `${c.kind}:${c.id}`).filter((k) => !staticKeys.has(k));
  check(dead.join() === "operator:positionoffsetrandom",
    `引擎认识但静态表没有 spec 的组件恰好一个（实得 ${JSON.stringify(dead)}）⇒ D2 回落点就在它身上`);
  check(P.particleSpec("operator", "oscillatealpha") !== null,
    "对照：被点名过的 oscillatealpha 其实早有静态 spec（不靠注册表回落）");
  check(
    P.particleSpec("operator", "positionoffsetrandom") === null && specStatus("operator", "positionoffsetrandom") === "noPanel",
    "没有插件贡献时：operator:positionoffsetrandom 无 spec ⇒ noPanel（引擎认识但本版无控件 = 死通道）",
  );
  const params = [
    { key: "frequencymin", type: "float", min: 0, max: 60, step: 0.01, label: "频率下限" },
    { key: "scalemin", type: "float" },
    { key: "mode", type: "enum", options: [{ value: "a", label: "A" }, "b"] },
    { key: "tint", type: "color" },
    { key: "uv", type: "vec4" },
    { key: "tex", type: "texture" },
    { key: "flag", type: "bool" },
    { key: "note", type: "string", label: { zh: "备注", en: "Note" } },
  ];
  const off = reg.add({ id: "positionoffsetrandom", kind: "operator", params }, "ext:verify");
  const spec = P.particleSpec("operator", "positionoffsetrandom");
  check(
    !!spec && keys(spec.fields) === "frequencymin:float,scalemin:float,mode:enum,flag:bool,note:string",
    `注册表有 params ⇒ particleSpec 非 null 且字段逐项等于转换结果（实得 ${spec ? keys(spec.fields) : "null"}）`,
  );
  check(
    !!spec && spec.fields.length === 5 && spec.fields[0].min === 0 && spec.fields[0].max === 60 && spec.fields[0].step === 0.01 && spec.fields[0].label === "频率下限",
    "转换带走 min / max / step 与 string 形态 label",
  );
  check(
    !!spec && spec.fields.find((f) => f.key === "note")?.label === undefined && spec.fields.find((f) => f.key === "mode")?.options?.join() === "a,b",
    "label 只取 string 形态（{zh,en} 表不塞，面板回落字段名）；enum 的 {value,label} 取 value",
  );
  check(specStatus("operator", "positionoffsetrandom") === "ok", "插件补了 params ⇒ 面板状态由 noPanel 升为 ok（D2 的意义）");
  const view = P.particleComponentViews({ operator: [{ name: "positionoffsetrandom", frequencymin: 3 }] })[0];
  check(
    view?.status === "ok" && view.views.length === 1 && view.views[0].key === "operator[0].frequencymin",
    "真跑消费侧：文件里写了 frequencymin ⇒ 面板出该字段（此前一个字段都没有）",
  );
  check(P.particleSpec("operator", "PositionOffsetRandom") !== null && specStatus("operator", "PositionOffsetRandom") === "ok",
    "注册表回落大小写不敏感（文件里写 PositionOffsetRandom 也命中）");
  check(P.particleSpec("operator", "zzz-nope-x") === null && specStatus("operator", "zzz-nope-x") === "unknown",
    "纯造出来的未知名仍是 unknown（不许被回落吞成 ok）");
  const offStatic = reg.add({ id: "alphafade", kind: "operator", params: [{ key: "nope", type: "float" }] }, "ext:verify");
  check(P.particleSpec("operator", "alphafade")?.fields.some((f) => f.key === "fadeintime") === true,
    "静态表命中的组件优先用静态 spec，插件同键贡献不改写它");
  offStatic();
  off();
  const offEmpty = reg.add({ id: "positionoffsetrandom", kind: "operator", params: [{ key: "tint", type: "color" }] }, "ext:verify");
  check(
    P.particleSpec("operator", "positionoffsetrandom") === null && specStatus("operator", "positionoffsetrandom") === "noPanel",
    "params 全是粒子侧没有控件的类型 ⇒ 转换后 0 字段 ⇒ 仍 noPanel（不静默变 ok）",
  );
  offEmpty();
  check(
    specStatus("initializer", "turbulentvelocityrandom") === "unsupported" && specStatus("emitter", "boxrandom") === "ok" && P.particleSpec("controlpoint", "") !== null,
    "三态回归：engineUnsupported=unsupported / 静态表命中=ok / controlpoint 恒有 spec",
  );
  off();
  check(P.particleSpec("operator", "positionoffsetrandom") === null && specStatus("operator", "positionoffsetrandom") === "noPanel",
    "撤回贡献（Disposer）后回落到 noPanel");

  // ── L4：BOM 与序列化保真 ──
  const obj = { maxcount: 12, emitter: [{ name: "boxrandom", rate: 3 }] };
  const plain = JSON.stringify(obj);
  const pBom = P.parseParticleFile("\uFEFF" + plain);
  check(!!pBom && JSON.stringify(pBom) === JSON.stringify(P.parseParticleFile(plain)),
    "带 UTF-8 BOM 的文本能 parse，且与不带 BOM 结果逐键等价（此前整份 parse 失败 ⇒ 面板空白）");
  check(pBom?.maxcount === 12, "带 BOM 时字段真的读得出来（不是「回落 null 也算过」）");
  check(P.parseParticleFile(plain)?.maxcount === 12 && P.parseParticleFile("{oops") === null && P.parseParticleFile("[1]") === null,
    "不带 BOM 行为不变；非法 JSON / 顶层不是对象仍返回 null");
  const text = new TextDecoder().decode(P.serializeParticleFile(obj));
  check(JSON.stringify(P.parseParticleFile(text)) === JSON.stringify(obj), "序列化产物 parse 回来与原对象逐键等价");
  check(text.startsWith('{\n  "maxcount": 12'), "序列化仍是 JSON.stringify(..., 2) 的 2 空格缩进（既有口径）");
  return res;
}

console.log("\n[10] D2：插件贡献的粒子组件参数通道（真跑 editor/particle-params.ts）");
console.log("[11] L4：粒子文件 BOM 与序列化保真");
const ppBefore = fs.readFileSync(PP, "utf8");
const ppSha = createHash("sha256").update(ppBefore).digest("hex");
for (const r of await ppSuite(await loadParticleParams())) {
  console[r.ok ? "log" : "error"](`  ${r.ok ? "✓" : "✗"} ${r.msg}`);
  if (!r.ok) failed++;
}

console.log("\n[12] 变异红测（把判定改坏 → 对应判据必须变红；覆盖只在内存里，不落盘）");
const ppMutants = [
  ["删掉注册表回落", "  const fields = contributedFields(kind, name);", "  const fields = null;"],
  ["回落对未知名也命中", "    if (`${c.kind}:${c.id}`.toLowerCase() !== want) continue;", "    void want;"],
  ["noPanel 被吞成 ok", '  if (kind !== "controlpoint" && isKnownComponent(kind, name)) return "noPanel";', '  return "ok";'],
  ["BOM 不再剥离", 'JSON.parse(text.replace(/^\\uFEFF/, ""))', "JSON.parse(text)"],
  ["color/vec4/texture 不再跳过", "    const type = SCHEMA_FIELD_TYPES[f.type];", '    const type = SCHEMA_FIELD_TYPES[f.type] ?? "float";'],
];
for (const [label, from, to] of ppMutants) {
  if (!ppBefore.includes(from)) {
    console.error(`  ✗ ${label}：注入点不存在（源码改过？同步更新本脚本）`);
    failed++;
    continue;
  }
  let red = 0;
  try {
    red = (await ppSuite(await loadParticleParams({ [PP]: ppBefore.replace(from, to) }))).filter((r) => !r.ok).length;
  } catch {
    red = 1; // 变异把模块弄到打不出来，也算被逮到
  }
  console[red ? "log" : "error"](`  ${red ? "✓" : "✗"} ${label} → ${red} 条判据变红`);
  if (!red) failed++;
}
check(createHash("sha256").update(fs.readFileSync(PP, "utf8")).digest("hex") === ppSha,
  "变异只在内存里覆盖（esbuild overrides），跑完源文件 sha256 与运行前逐字一致");

console.log(failed === 0 ? "\nverify-particle-constants: 全部通过 ✓" : `\nverify-particle-constants: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
