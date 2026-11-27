#!/usr/bin/env node
/**
 * verify-mat —— 4x4 乘法的**唯一实现**契约（B4）。
 *
 * 2026-10 把 `mdl-math.js` 的显式四项求和合并到 `math.js` 的 mat4Multiply（mdl 侧改为委托）。
 * 合并前实测两者**并非逐位等价**：1e5 组随机矩阵里 244 组位型不同，全部是零的符号
 * （`0 + (-0)` 会归一成 `+0`，显式求和则保留 `-0`）。零的符号不影响比较、也不影响渲染像素，
 * 但合并的意义就是只留**一处**，所以这里钉三件事：
 *   1. 值等价：与判据内**独立实现**（显式四项求和）在全量随机输入上 `===` 相等。
 *      **它抓的是「精度被破坏」而不是「项序被改」** —— 实测：把累加顺序倒过来
 *      位型差异 0 组（四个 float32 乘积用 float64 累加是**精确**的，和 ≤50 位有效数字），
 *      而把每步 `Math.fround` 成 float32 累加会产生 12.7 万处位型差异。所以这条判据
 *      不是「顺序守卫」，别指望它拦重排（那本来就不可观测）；
 *   2. 位等价：`mdl-math.mat4Mul` 与 `math.mat4Multiply` 位型完全一致（含 ±0）——
 *      这是合并后的**新不变量**，也是「别再长出第二份实现」的闸门；
 *   3. `mat4Invert` **不合并**：mdl 侧必须仍是 f64 高斯消元（数值路径不同，骨骼绑定依赖它）。
 *
 * 输入分布刻意覆盖 0 / -0 / 次正规 / 大值 / 混合 —— 只喂 [0,1) 随机数是测不到零符号差异的
 * （那正是合并前那次「逐位等价」误判的成因）。
 *
 * ---- 2026-10 追加：M1.2（G3）blending 名称守卫 + M1.7（G4）g_Texture0Resolution .zw 债 ----
 *
 * §4 `passes[].blending` 的**名称面**（不是 GLSL 那条数值混合）。`render/renderer-glsl.js:115-197`
 *   的 `ApplyBlending(int mode, …)`（mode 0–32，号同 WE `common_blending.h`）服务的是 scene.json /
 *   材质的 `colorBlendMode` **数字**，与 `passes[].blending` 的**字符串**之间没有任何映射表。
 *   字符串只有四条渲染路径各自 `===` / `!==` 地比较少数几个名字，其余**一律静默落进 else 默认档**：
 *     · `render/renderer.js:2460-2470` `setBlend(mode)`（效果 pass；调用点 `:5150` `mp.blending || 'normal'`）
 *     · `render/renderer.js:3258-3267` 图层基色材质（`spec.blending || 'normal'`）
 *     · `render/mdl.js:861-869` 网格模型（`opts.blending`）
 *     · `render/particles.js:1039` + `:2422-2424` 粒子（`pass.blending || 'translucent'`）
 *   §4 把「源码里被显式识别的名字」抽出来与脚本声明的集合比对（任一路径新增/删分支即红），
 *   再把集合外的值逐项列名 —— 不允许静默。`alphatocoverage`（语料里 17 个 pass）**已知未接线**：
 *   `render/mdl.js:766/:912` 只拿它当绘制排序用，`renderer/vendor/we-scene/headers.ts:1090-1091` 的
 *   `ApplyAlphaToCoverage` / `#if ALPHATOCOVERAGE` 从未被 combo 打开（`render/mdl.js:178-179` 自注）。
 *   见 `docs/RENDERER-COMPLETION-PLAN.md` G3（`:202-206`，方案 (b)：明确不做 + 本守卫）。
 *
 *   **口径边界（task-18 收口，别把判据名当成比它实际覆盖范围更大的东西）**：§4 是**代码侧**判据 ——
 *   它 `readFileSync` 的只有引擎源码（`render/renderer.js`、`render/mdl.js`、`render/particles.js`、
 *   `headers.ts`），**不读任何 `effect.json` / `scene.json`**。所以它守的是「代码 ↔ 声明」漂移，
 *   **不覆盖素材取值**：把真实素材里的 `passes[].blending` 改成集合外的新名字，本脚本不会自己发现。
 *   素材侧名单靠脚本内 `CORPUS_OBSERVED_BLENDING` 台账**对账**（见 §4 的「台账对账」断言）：
 *   台账记着普查观测到的名字，断言它们全部能被代码侧显式分类 —— 两边一分叉就红，而门禁仍然
 *   不读素材库（避免全库解析爆内存，保持 docs/COMPLIANCE.md 的「夹具一律合成」）。
 *   台账溯源与那 1 的计数差异见 `CORPUS_OBSERVED_BLENDING` 的注释；素材侧完整权重表见
 *   `docs/RENDERER-COMPLETION-PLAN.md` §3（`:155-184`）。
 *
 * §5 `g_Texture0Resolution` 的 `.zw` 在本仓有**两套互相矛盾的约定**，这是**已知不一致的记录**、
 *   不是待办：效果链 `render/renderer.js:5263` 绑 `[w, h, w, h]`（.zw = 宽高，`headers.ts:257-258`
 *   的注释描述的就是这一套：四个分量都是像素尺寸、都是被除数），由 `render/renderer.js:1906-1907`
 *   逐分量原样上传；粒子路径 `render/particles.js:2409` 绑 `tw, th, 1 / tw, 1 / th`（.zw = 倒数）。
 *   两者都拿 `.z` / `.w` 当**除数**（`headers.ts:248-250`：`g_Scale.y / g_Texture0Resolution.w`），
 *   于是同一份 shader 在两条路径上的 step 相差一个尺寸平方。**不修实现**（统一会改动 HDR / 粒子的
 *   可见行为，已裁决，见 `docs/RENDERER-COMPLETION-PLAN.md` G4 `:208-214`）。
 *   §5 两条断言**各自钉住一套口径**：任何未来统一都会让其中一条翻转 —— 那正是信号，不是判据写错。
 *   翻转时请连同 `headers.ts:257-258` 的注释与 G4 一起改，别把这条断言删掉了事。
 *
 * §6 `passes[].combos` 是**另一套命名空间**，与 §4 的 `passes[].blending` 无关，判据也分开：
 *   · `blending` 是**闭集枚举** —— 引擎里就那三四个字符串，`===` 比较得出来（§4）。
 *   · combo 键是**开集** —— 名字由**每个 shader 自己**的
 *     `// [COMBO] {"combo":"NAME","default":N}` 声明与 `#if NAME` 引用决定
 *     （`render/hlsl2glsl.js:217-225` 取 default、`:296-303` 收名字、`render/hlsl-preprocessor.js:207-213` 求 `#if`），
 *     引擎只**额外注入**少数几个：平台宏 `GLSL`（`hlsl2glsl.js:225`）、绑定贴图注入的
 *     `TEXnFORMAT`（`hlsl2glsl.js:341-345`）、纹理关联 combo（`renderer.js:1348`/`:1405-1407`）、
 *     以及音频示波器那条补丁的 `WRITEALPHA`/`TRANSPARENCY`（`renderer.js:5015-5018`，仅该 shader 生效）。
 *   所以 §6 **不**去枚举「全部合法 combo 名」（开集，枚举不出来、也不该枚举），而是钉住三件事：
 *     1. 引擎**自己写进去**的键不许悄悄长 —— `ENGINE_WRITTEN_COMBOS` 与源码抽取集合必须相等；
 *     2. 材质给了一个该 shader **既不声明也不引用**的键时，引擎**不吭声**：`hlsl2glsl` 的输出与
 *        不给这个键时**逐字符相同**（键只进了程序缓存键 `effectComboKey`，`renderer.js:1364-1371`）；
 *     3. shader 引用了、但既无 `[COMBO]` 声明也没人提供的 combo 是**静默按 0 求值**
 *        （`hlsl-preprocessor.js:212` 的 `return '0'`）—— 不报错、不留痕；而同一名字若出现在
 *        **表达式里裸用**，则**原样保留**（不在 `comboNames` 里就不替换）→ 留给下游 GLSL 编译报错。
 *        这个「`#if` 里静默、裸用才炸」的不对称就是「未知 combo 静默落默认档」的确切形状。
 *   §6 的第 2/3 条用**真翻译器**跑（`hlsl2glsl` / `preprocess` 在 Node 下可加载、纯函数、不开 GPU），
 *   输入是进程内合成的 shader 字符串 —— 不是正则比对，也不读素材库。
 */
import fs from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(here, "..");
const R = join(ROOT, "renderer/vendor/we-scene/render/");

let failed = 0;
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

const { mat4Multiply } = await import(pathToFileURL(join(R, "math.js")).href);
const { mat4Mul } = await import(pathToFileURL(join(R, "mdl-math.js")).href);

const bits = (f) => {
  const u = new Uint32Array(1);
  new Float32Array(u.buffer)[0] = f;
  return u[0];
};

/** 独立实现：显式四项求和（与 md4Multiply 的循环累加是不同写法，同语义） */
function reference(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

let rng = 20261001;
const rand = () => {
  rng = (rng * 1664525 + 1013904223) >>> 0;
  return rng / 4294967296;
};
/** 取值分布：0 / -0 / 次正规 / 大值 / 常规，目的是把零符号与舍入边界都喂到 */
const pick = () => {
  const r = rand();
  if (r < 0.06) return 0;
  if (r < 0.12) return -0;
  if (r < 0.2) return (rand() - 0.5) * 1e-30;
  if (r < 0.3) return (rand() - 0.5) * 1e6;
  return rand() * 4 - 2;
};

console.log("\n[1] 值等价：与独立参考实现在 1e5 组随机矩阵上 ===（抓精度破坏：如逐步 fround / 改乘积顺序）");
{
  let valueDiff = 0;
  let firstBad = null;
  let zeroSignOnly = 0;
  for (let n = 0; n < 100000; n++) {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      a[i] = pick();
      b[i] = pick();
    }
    const x = mat4Multiply(a, b);
    const ref = reference(a, b);
    for (let i = 0; i < 16; i++) {
      if (x[i] === ref[i]) {
        if (bits(x[i]) !== bits(ref[i])) zeroSignOnly++; // 允许：零符号（见文件头注）
        continue;
      }
      valueDiff++;
      if (!firstBad) firstBad = { n, i, x: x[i], ref: ref[i] };
      break;
    }
  }
  check(valueDiff === 0, `1e5 组矩阵值全部相等（不等 ${valueDiff} 组，首个 ${JSON.stringify(firstBad)}）`);
  console.log(`  · 信息：其中 ${zeroSignOnly} 个元素与参考实现只差零的符号（+0 / -0，允许，渲染等价）`);
}

console.log("\n[2] 位等价：mat4Mul 与 mat4Multiply 是同一份实现（含 ±0）");
{
  let bitDiff = 0;
  let outOk = true;
  for (let n = 0; n < 20000; n++) {
    const a = new Float32Array(16);
    const b = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      a[i] = pick();
      b[i] = pick();
    }
    const out = new Float32Array(16);
    const viaOut = mat4Mul(a, b, out);
    if (viaOut !== out) outOk = false;
    const x = mat4Multiply(a, b);
    for (let i = 0; i < 16; i++) {
      if (bits(out[i]) !== bits(x[i])) {
        bitDiff++;
        break;
      }
    }
  }
  check(bitDiff === 0, `2e4 组位型完全一致（不一致 ${bitDiff} 组）`);
  check(outOk, "mat4Mul 的 out 参数语义保留（写入并返回传入的缓冲，9 处三参调用依赖它）");
}

console.log("\n[3] 接线：只允许一份乘法实现；mat4Invert 保持双份");
{
  const mathSrc = fs.readFileSync(join(R, "math.js"), "utf8");
  const mdlSrc = fs.readFileSync(join(R, "mdl-math.js"), "utf8");
  check(/export function mat4Multiply\(a, b, out\)/.test(mathSrc), "math.js 是规范实现且支持 out");
  const mdlMul = /function mat4Mul\(a, b, out\) \{\s*\n\s*return mat4Multiply\(a, b, out\)/.test(mdlSrc);
  check(mdlMul, "mdl-math 的 mat4Mul 必须委托（不得再长出第二份乘法循环）");
  check(/import \{ mat4Multiply \} from '\.\/math\.js'/.test(mdlSrc), "mdl-math 必须从 math.js 导入乘法");
  // 不合并 invert：两侧都要在，且 mdl 侧是高斯消元（按 pivot 行交换判定）
  check(/function mat4Invert\(m\) \{[\s\S]{0,600}?let piv = col/.test(mdlSrc), "mdl-math 的 mat4Invert 必须仍是 f64 高斯消元（不合并）");
  check(/export function mat4Invert\(m\) \{/.test(mathSrc), "math.js 的 mat4Invert 保留（余子式实现，与 mdl 侧数值路径不同）");
}

/**
 * 声明面：本仓**真正识别**的 `passes[].blending` 名称（会作用到 GL 混合状态）。
 * 逐个 grep 四条路径得来（见文件头 §4）：setBlend → {translucent, additive}，
 * 图层基色 → {additive, normal}，网格 → {additive, normal}，粒子 → {additive}（+ 缺省 translucent）。
 * 缺省值各路径不同（效果/图层/网格 = 'normal'，粒子 = 'translucent'），但都落在这个集合内。
 */
const SUPPORTED_BLENDING = ["normal", "translucent", "additive"];
/** 语料里出现、本仓**未接线**的名字（不是「支持」也不是「未知」：只当绘制排序 + combo 未打开） */
const KNOWN_UNWIRED_BLENDING = ["alphatocoverage"];

/**
 * **素材侧台账**（task-18 收口）：`passes[].blending` 在真实语料里**被观测到**出现过的名字。
 *
 * 溯源：Lead 归档的 **2026-10-12 本机语料普查**（语料 B，361 个 pkg / **8931 个材质 JSON
 * （解析成功 8930 / 解析失败 1）**），其中 `passes[].blending` 的取值计数见下面的
 * `CORPUS_OBSERVED_BLENDING_COUNTS`。总数口径见 `docs/RENDERER-COMPLETION-PLAN.md:157`
 * （§3 语料权重表，`:155-184`：361 个 pkg / 358 个场景 / 8931 个材质 JSON / 617 个 `.mdl`）；
 * 同表 `:166` 记「`blending = "alphatocoverage"` | **17** 个 pass」，与本台账一致。
 *
 * 语义：这是**观测值**（素材里实际出现过什么），不是契约值（允许出现什么）。
 * **本判据是代码侧判据，不读素材**：门禁里跑全库解析会爆内存，且 docs/COMPLIANCE.md 要求夹具
 * 一律合成。台账只用来做**名单对账** —— 观测到的每个名字都必须在**代码侧**被显式分类
 * （`SUPPORTED_BLENDING` ∪ `KNOWN_UNWIRED_BLENDING`）。两边一分叉就红：
 *   · 素材里冒出第四种名字 → 要么代码侧补分类，要么把新计数并进本台账，两条路都得有人**显式**做；
 *   · 代码侧删掉某个已分类的名字 → 同一批断言里也会红（声明集合 == 源码识别集合那条）。
 * 它**不**能发现「真实素材被改坏」——那是素材侧的事，见文件头 §4 的「口径边界」。
 */
const CORPUS_OBSERVED_BLENDING = ["translucent", "normal", "additive", "alphatocoverage"];
/** 上面每个名字在同一次普查里的 pass 计数（合计 4078+3677+958+17 = 8730 个带 blending 的 pass）。 */
const CORPUS_OBSERVED_BLENDING_COUNTS = {
  translucent: 4078,
  normal: 3677,
  additive: 958,
  alphatocoverage: 17,
};

console.log(
  "\n[4] M1.2 blending 名称面（**代码侧**判据）：声明集合 == 源码识别集合；集合外的值必须逐项列名；" +
    "素材侧名单靠 CORPUS_OBSERVED_BLENDING 台账对账（不读素材，见文件头 §4 口径边界）（G3）",
);
{
  const RES = join(ROOT, "renderer/vendor/we-scene/");
  const rendererSrc = fs.readFileSync(join(R, "renderer.js"), "utf8");
  const mdlSrc = fs.readFileSync(join(R, "mdl.js"), "utf8");
  const particlesSrc = fs.readFileSync(join(R, "particles.js"), "utf8");
  const headersSrc = fs.readFileSync(join(RES, "headers.ts"), "utf8");

  // 「真源」：把每条渲染路径里**显式比较过** blending 的切片切出来，再从中汇聚名字。
  const sites = [
    {
      where: "setBlend（效果 pass）",
      file: "render/renderer.js:2460-2470",
      src: rendererSrc,
      re: /function setBlend\(mode\) \{([\s\S]*?)\n  \}\n/,
    },
    {
      where: "图层基色材质",
      file: "render/renderer.js:3258-3267",
      src: rendererSrc,
      re: /const blending = spec\.blending \|\| 'normal'([\s\S]{0,600}?)gl\.blendFuncSeparate\(gl\.SRC_ALPHA, gl\.ONE_MINUS_SRC_ALPHA, gl\.ONE, gl\.ONE_MINUS_SRC_ALPHA\)/,
    },
    {
      where: "效果 pass 覆盖写清屏条件",
      file: "render/renderer.js:5346-5352",
      src: rendererSrc,
      // [2026-11-27 PR#28] 内联单行条件抽成纯函数 effectPassNeedsClear（首写 pong 也清）。
      // 这里必须匹配**调用点整段**而不是函数名：m[0] 里的 'translucent'/'additive' 字面量
      // 是本脚本「源码识别集合 == 声明集合」的真源证据，匹配文本没了字面量 = 断言失去牙。
      re: /const needClear = effectPassNeedsClear\(\s*!!mp\.target,\s*blendMode,\s*outFBO === fboB,\s*!pongWritten,\s*\)/,
    },
    {
      where: "网格模型（.mdl）",
      file: "render/mdl.js:861-869",
      src: mdlSrc,
      re: /if \(opts\.blending === 'additive'\)([\s\S]{0,400}?)gl\.blendFuncSeparate\(gl\.SRC_ALPHA, gl\.ONE_MINUS_SRC_ALPHA, gl\.ONE, gl\.ONE_MINUS_SRC_ALPHA\)/,
    },
    {
      where: "粒子",
      file: "render/particles.js:2422-2424",
      src: particlesSrc,
      re: /if \(this\.blend === 'additive'\) gl\.blendFunc\(gl\.SRC_ALPHA, gl\.ONE\)/,
    },
  ];
  const sourceSupported = new Set();
  let setBlendBody = "";
  for (const s of sites) {
    const m = s.re.exec(s.src);
    check(!!m, `真源可定位：${s.where}（${s.file}）`);
    if (!m) continue;
    if (s.where.startsWith("setBlend")) setBlendBody = m[0];
    for (const mm of m[0].matchAll(/(?:===|!==)\s*'([A-Za-z]+)'/g)) sourceSupported.add(mm[1]);
  }
  const srcList = [...sourceSupported].sort();
  check(
    srcList.join(",") === [...SUPPORTED_BLENDING].sort().join(","),
    `源码识别集合 == 声明集合（源码 [${srcList.join(", ")}] vs 声明 [${SUPPORTED_BLENDING.join(", ")}]）` +
      `：不同 = 某条路径新增/删除了 blending 分支，必须同步 SUPPORTED_BLENDING 与文件头 §4`,
  );
  // 「集合外的名字会静默落进默认档」这件事本身的证据：每条路径都有 else 兜底
  check(
    /else \{\s*\n\s*gl\.disable\(gl\.BLEND\)/.test(setBlendBody),
    "setBlend 的 else 兜底存在（= 集合外的名字静默关混合，这正是本守卫存在的理由）",
  );
  // 缺省值也是真源：粒子默认 'translucent'（与效果/图层/网格的 'normal' 不同），且必须在集合内
  const parDefault = /this\.blend = \(pass && pass\.blending\) \|\| '([a-z]+)'/.exec(particlesSrc);
  check(!!parDefault, "真源可定位：粒子 blending 缺省（render/particles.js:1039）");
  check(
    !!parDefault && SUPPORTED_BLENDING.includes(parDefault[1]),
    `粒子缺省值 '${parDefault ? parDefault[1] : "?"}' 落在声明集合内（缺省不得是未接线名）`,
  );

  // 分类：以**源码抽取的集合**为准（而非声明常量），所以源码一改，下面的报告就跟着变
  const classify = (raw) => {
    if (typeof raw !== "string" || raw === "") return { name: "(缺省)", kind: "default" };
    if (sourceSupported.has(raw)) return { name: raw, kind: "gl" };
    if (KNOWN_UNWIRED_BLENDING.includes(raw)) return { name: raw, kind: "unwired" };
    return { name: raw, kind: "unknown" };
  };

  // 合成夹具：`passes[]` 的最小子集，进程内构造（绝不读素材库）——**这是代码侧判据，不是素材取值核对**。
  // 取值直接复用素材侧台账（CORPUS_OBSERVED_BLENDING），避免「台账一份、夹具再抄一份」两个真相源：
  // 台账里加一个名字，夹具与下面的分账对账会一起跟着走。
  const SYNTH_FIXTURE_BLENDING = CORPUS_OBSERVED_BLENDING;
  const fixtures = [
    ...SYNTH_FIXTURE_BLENDING.map((v) => ({ where: `合成夹具 blending=${v}`, pass: { blending: v } })),
    { where: "缺省（无 blending 键）", pass: {} },
    { where: "blending=null", pass: { blending: null } },
    { where: 'blending=""', pass: { blending: "" } },
  ];
  const unknownRows = [];
  const unwiredRows = [];
  for (const f of fixtures) {
    const r = classify(f.pass.blending);
    if (r.kind === "unknown") unknownRows.push(`${f.where} → ${r.name}`);
    if (r.kind === "unwired") unwiredRows.push(`${f.where} → ${r.name}`);
    console.log(`  · ${f.where} → ${r.kind}`);
  }
  check(
    unknownRows.length === 0,
    `合成夹具的 blending 形态全部被显式归类（**代码侧**判据，不读素材；未识别 ${unknownRows.length} 项${unknownRows.length ? "：" + unknownRows.join(" / ") : ""}）`,
  );
  check(
    unwiredRows.length === 1 && unwiredRows[0].includes("alphatocoverage"),
    `alphatocoverage 被显式列为「已知未接线」而非支持（列出 ${unwiredRows.length} 项）`,
  );
  check(
    !sourceSupported.has("alphatocoverage"),
    "alphatocoverage 不在源码识别集合内（未接线；headers.ts 的 ApplyAlphaToCoverage 是死代码）",
  );
  check(
    /void ApplyAlphaToCoverage\(inout float alpha\) \{\n#if ALPHATOCOVERAGE/.test(headersSrc),
    "headers.ts 仍有 ApplyAlphaToCoverage + #if ALPHATOCOVERAGE（combo 未打开，别当成已实现）",
  );

  // ---- 台账对账（task-18）：素材侧观测名单 ⊆ 代码侧分类。**不读素材**，只对账 ----
  // 这是「代码侧判据不覆盖素材取值」这个空洞的补丁：素材里出现过的名字必须在代码侧被显式分类，
  // 两边一分叉就红。台账是**记录**（含溯源注释），不是现场重跑语料。
  const ledgerKinds = CORPUS_OBSERVED_BLENDING.map((v) => `${v}→${classify(v).kind}`);
  console.log(
    `  · 素材侧台账（${CORPUS_OBSERVED_BLENDING.length} 个名字 / 合计 ` +
      `${Object.values(CORPUS_OBSERVED_BLENDING_COUNTS).reduce((a, b) => a + b, 0)} 个 pass）→ 代码侧分类：` +
      ledgerKinds.join(", "),
  );
  const unheard = CORPUS_OBSERVED_BLENDING.filter((v) => classify(v).kind === "unknown");
  check(
    unheard.length === 0,
    `素材侧台账 ⊆ 代码侧分类（SUPPORTED_BLENDING ∪ KNOWN_UNWIRED_BLENDING）：未分类 ${unheard.length} 名` +
      `${unheard.length ? "：" + unheard.join(" / ") : ""}` +
      `：红 = 素材里出现过、代码侧却没人显式分类的名字（别再指望 else 默认档兜住）` +
      `，修法是「补分类」或「把新计数并进台账」二选一，两条路都得有人显式做`,
  );
  // 台账自身的自洽：名单 ↔ 计数表一一对应、无重名、计数都是正整数。
  // 防止有人只加名单不加计数（或反之）——那种「半份台账」对账时看起来是绿的，其实已经失真。
  const ledgerNames = Object.keys(CORPUS_OBSERVED_BLENDING_COUNTS);
  check(
    ledgerNames.length === CORPUS_OBSERVED_BLENDING.length &&
      new Set(CORPUS_OBSERVED_BLENDING).size === CORPUS_OBSERVED_BLENDING.length &&
      CORPUS_OBSERVED_BLENDING.every((v) => ledgerNames.includes(v)),
    `台账自洽：名单与计数表一一对应且无重名（名单 ${CORPUS_OBSERVED_BLENDING.length} / 计数表 ${ledgerNames.length}）`,
  );
  check(
    ledgerNames.every((k) => Number.isInteger(CORPUS_OBSERVED_BLENDING_COUNTS[k]) && CORPUS_OBSERVED_BLENDING_COUNTS[k] > 0),
    `台账自洽：每个名字都有正整数计数（${ledgerNames.map((k) => `${k}=${CORPUS_OBSERVED_BLENDING_COUNTS[k]}`).join(", ")}）`,
  );

  // 负数夹具：集合外的值必须落进 unknown（判红并逐项列名），不得被当成普通档静默放过
  const OUT_OF_SET = ["Additive", "screen", "multiply", "chromakey"];
  const missed = OUT_OF_SET.filter((v) => classify(v).kind !== "unknown");
  check(
    missed.length === 0,
    `集合外的 blending 值一律判为 unknown 并逐项列出（漏报 ${missed.length} 项${missed.length ? "：" + missed.join(", ") : ""}）`,
  );
  console.log(`  · 集合外样例（应判 unknown）：${OUT_OF_SET.map((v) => `${v}→${classify(v).kind}`).join(", ")}`);
}

console.log("\n[5] M1.7 g_Texture0Resolution 的 .zw：效果链=宽高、粒子=倒数（G4，已知不一致）");
{
  const rendererSrc = fs.readFileSync(join(R, "renderer.js"), "utf8");
  const particlesSrc = fs.readFileSync(join(R, "particles.js"), "utf8");

  // 效果链：resolutions.set(ti, [t.width, t.height, t.width, t.height])，再逐分量原样上传
  const effSet = /resolutions\.set\(ti, \[([^\]]+)\]\)/.exec(rendererSrc);
  check(!!effSet, "真源可定位：效果链 resolutions.set(ti, [ … ])（render/renderer.js:5263）");
  check(
    /setVal\(uni, 'g_Texture' \+ i \+ 'Resolution', \(l\) => gl\.uniform4f\(l, res\[0\], res\[1\], res\[2\], res\[3\]\)\)/.test(
      rendererSrc,
    ),
    "真源可定位：g_TextureNResolution 逐分量原样上传（render/renderer.js:1906-1907）",
  );
  // 粒子：gl.uniform4f(uRes, tw, th, 1 / tw, 1 / th)
  const parSet = /gl\.uniform4f\(uRes, ([^)]+)\)/.exec(particlesSrc);
  check(!!parSet, "真源可定位：粒子 gl.uniform4f(uRes, …)（render/particles.js:2405-2410）");

  // 把两条表达式在合成尺寸上**求值**（不是比对字面量）：任一改动都会让下面的期望翻转
  const W = 1920;
  const H = 1080;
  const evalExpr = (src) => {
    const js = src
      .replace(/\bt\.width\b/g, String(W))
      .replace(/\bt\.height\b/g, String(H))
      .replace(/\btw\b/g, String(W))
      .replace(/\bth\b/g, String(H));
    if (!/^[\d\s+\-*/().]+$/.test(js)) return NaN; // 只允许数字与四则运算
    try {
      return Function(`"use strict";return (${js})`)();
    } catch {
      return NaN;
    }
  };
  const parts = (m) => (m ? m[1].split(",").map((s) => s.trim()) : []);
  const effParts = parts(effSet);
  const parParts = parts(parSet);
  check(effParts.length === 4, `效果链 .xyzw 分量数 = 4（实际 ${effParts.length}）`);
  check(parParts.length === 4, `粒子 .xyzw 分量数 = 4（实际 ${parParts.length}）`);
  const eff = effParts.map(evalExpr);
  const par = parParts.map(evalExpr);
  check(
    eff[0] === W && eff[1] === H && eff[2] === W && eff[3] === H,
    `效果链 .xy=.zw=宽高（${W}x${H} 上求值 [${eff.join(", ")}]）—— 口径 A（headers.ts:257-258 描述的这套）`,
  );
  check(
    par[0] === W && par[1] === H && par[2] === 1 / W && par[3] === 1 / H,
    `粒子 .xy=宽高、.zw=倒数（${W}x${H} 上求值 [${par.join(", ")}]）—— 口径 B`,
  );
  check(
    eff[2] !== par[2] && eff[3] !== par[3],
    "两套 .zw 口径确实并存（效果链=宽高 vs 粒子=倒数）：统一任意一条都会让上面一条翻转，这是信号",
  );
}

/**
 * 引擎**自己写进 combos** 的键（与 shader 的 `[COMBO]` 声明无关的那几个）。
 * combo 键整体是开集（每个 shader 自己声明），所以这里只守引擎注入面，不假装枚举全集。
 */
const ENGINE_WRITTEN_COMBOS = ["GLSL", "WRITEALPHA", "TRANSPARENCY"];

console.log("\n[6] M1.2 combo 键：引擎注入面防漂移 + 未知键「不吭声」的事实（G3，与 §4 的 blending 是两套命名空间）");
{
  const hlslSrc = fs.readFileSync(join(R, "hlsl2glsl.js"), "utf8");
  const preSrc = fs.readFileSync(join(R, "hlsl-preprocessor.js"), "utf8");
  const rendererSrc = fs.readFileSync(join(R, "renderer.js"), "utf8");
  const { hlsl2glsl } = await import(pathToFileURL(join(R, "hlsl2glsl.js")).href);
  const { preprocess } = await import(pathToFileURL(join(R, "hlsl-preprocessor.js")).href);

  // ---- 1) 引擎写入面：从源码抽，和声明比（不枚举 shader 声明的开集） ----
  const written = new Set();
  check(
    /const effective = \{ (GLSL): 1, \.\.\.defaults, \.\.\.\(combos \|\| \{\}\) \}/.test(hlslSrc),
    "真源可定位：GLSL 平台宏注入且层叠序为 GLSL < [COMBO] default < 材质显式（render/hlsl2glsl.js:225）",
  );
  if (/const effective = \{ GLSL: 1,/.test(hlslSrc)) written.add("GLSL");
  const gatedRe = /if \(oc\.([A-Z_]+) === undefined && mc\.\1 === undefined\) combos\.\1 = (\d)/g;
  const gated = [...rendererSrc.matchAll(gatedRe)];
  check(gated.length > 0, "真源可定位：音频示波器补的默认 combo（render/renderer.js:5015-5018）");
  for (const g of gated) written.add(g[1]);
  const writtenList = [...written].sort();
  check(
    writtenList.join(",") === [...ENGINE_WRITTEN_COMBOS].sort().join(","),
    `引擎写入的 combo 键 == 声明（源码 [${writtenList.join(", ")}] vs 声明 [${ENGINE_WRITTEN_COMBOS.join(", ")}]）` +
      `：不同 = 引擎开始自己造 combo 键，必须同步 ENGINE_WRITTEN_COMBOS 与文件头 §6`,
  );
  check(
    /function parseTextureCombos\(src\)/.test(rendererSrc) && /effectiveCombos\[tc\.combo\] = 1/.test(rendererSrc),
    '纹理关联 combo：仅当 shader 的 sampler 注释声明 `"combo":"X"` 且该槽真有纹理时才注入 1（render/renderer.js:1348/:1405-1407）',
  );
  check(
    /code\.replace\(\/\\bTEX\\d\+FORMAT\\b\/g/.test(hlslSrc),
    "TEXnFORMAT 由绑定贴图按需注入（不写 [COMBO]；未提供时 #if 按 0）（render/hlsl2glsl.js:341-345）",
  );
  check(
    /function makeComboLookup\(combos\)/.test(preSrc) &&
      /if \(combos\[name\] !== undefined\) return combos\[name\]/.test(preSrc) &&
      /return k === undefined \? undefined : combos\[k\]/.test(preSrc),
    "combo 查表大小写不敏感：原样命中，再退化到小写表（render/hlsl-preprocessor.js:192-202）",
  );
  check(
    /const resolve = \(name\) => \{[\s\S]{0,240}?return '0'\n/.test(preSrc),
    "未声明/未提供的 combo 标识符在 #if 里按 0 求值（render/hlsl-preprocessor.js:207-213 的 return '0'）—— 「静默」的总开关",
  );

  // ---- 2) [COMBO] 声明解析：把源码里的正则**字面量**取出来现场求值，再扫合成 shader ----
  const declLit = /const comboRe = (\/.+?\/g)\n/.exec(hlslSrc);
  const nameLit = /const comboRe2 = (\/.+?\/g)\n/.exec(hlslSrc);
  check(!!declLit && !!nameLit, "真源可定位：`[COMBO]` 声明正则（hlsl2glsl.js:219 带 default / :296 只收名字）");
  const comboDeclRe = declLit ? Function(`return ${declLit[1]}`)() : null;
  const comboNamesRe = nameLit ? Function(`return ${nameLit[1]}`)() : null;
  check(
    comboDeclRe instanceof RegExp && comboNamesRe instanceof RegExp,
    "源码正则字面量现场求值可用（有人改写法/改语法，本行即红，而不是悄悄漏掉所有声明）",
  );

  // 合成 shader：进程内字符串，不读素材库、不落盘
  const SYNTH_FRAG = [
    '// [COMBO] {"combo":"LIGHTING","default":1}',
    '// [COMBO] {"combo":"CUTOUT","default":0}',
    "uniform mediump sampler2D g_Texture0;",
    "void main() {",
    "  float a = 0.0;",
    "#if LIGHTING",
    "  a += 1.0;",
    "#else",
    "  a += 2.0;",
    "#endif",
    "#if CUTOUT",
    "  a += 4.0;",
    "#endif",
    "  float b = LIGHTING;",
    "  gl_FragColor = vec4(a, b, 0.0, 1.0);",
    "}",
  ].join("\n");
  const declared = new Map();
  if (comboDeclRe) {
    let m;
    while ((m = comboDeclRe.exec(SYNTH_FRAG)) !== null) declared.set(m[1], Number(m[2]));
  }
  const declaredNames = new Set();
  if (comboNamesRe) {
    let m;
    while ((m = comboNamesRe.exec(SYNTH_FRAG)) !== null) declaredNames.add(m[1]);
  }
  // shader「认得」的键 = [COMBO] 声明 ∪ #if/#elif/#ifdef/#ifndef 里引用到的标识符
  const referenced = new Set();
  for (const d of SYNTH_FRAG.matchAll(/^[ \t]*#(?:if|elif|ifdef|ifndef)\b([^\n]*)/gm)) {
    for (const id of d[1].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) referenced.add(id[1]);
  }
  check(
    declared.size === 2 && declared.get("LIGHTING") === 1 && declared.get("CUTOUT") === 0,
    `[COMBO] 声明解析出 {LIGHTING: default 1, CUTOUT: default 0}（实际 ${JSON.stringify(Object.fromEntries(declared))}）`,
  );
  check(
    declaredNames.size === 2 && referenced.has("LIGHTING") && referenced.has("CUTOUT"),
    `shader 认得的键 = 声明 ∪ #if 引用（声明 [${[...declaredNames].join(", ")}]，引用 [${[...referenced].sort().join(", ")}]）`,
  );

  // ---- 3) 合成材质夹具：未知键必须被逐项列名（含大小写不敏感与最近邻提示） ----
  const engineLower = new Set(ENGINE_WRITTEN_COMBOS.map((s) => s.toLowerCase()));
  const refLower = new Map([...referenced].map((r) => [r.toLowerCase(), r]));
  const kindOf = (key) => {
    const k = String(key).toLowerCase();
    if (engineLower.has(k)) return "engine";
    if (refLower.has(k)) return "shader";
    return "unknown";
  };
  const editDistance = (a, b) => {
    const prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let last = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
        last = tmp;
      }
    }
    return prev[b.length];
  };
  const nearest = (key) => {
    let best = null;
    for (const r of referenced) {
      const d = editDistance(String(key).toLowerCase(), r.toLowerCase());
      if (d <= 2 && (best === null || d < best.d)) best = { d, name: r };
    }
    return best ? best.name : null;
  };
  const reportCombos = (materialCombos) => {
    const known = [];
    const unknown = [];
    for (const k of Object.keys(materialCombos)) (kindOf(k) === "unknown" ? unknown : known).push(k);
    return { known, unknown };
  };
  const CASES = [
    { label: "合成材质：两个声明过的键", combos: { LIGHTING: 0, CUTOUT: 1 }, expect: [] },
    { label: "合成材质：换成小写（引擎查表不敏感）", combos: { lighting: 0, cutout: 1 }, expect: [] },
    { label: "合成材质：多一个 shader 没提过的 FOO", combos: { LIGHTING: 1, FOO: 1 }, expect: ["FOO"] },
    { label: "负数夹具：LIGHTING 拼错成 LIGHTINGX", combos: { LIGHTINGX: 1 }, expect: ["LIGHTINGX"] },
  ];
  let listedAny = false;
  for (const c of CASES) {
    const r = reportCombos(c.combos);
    if (r.unknown.length) listedAny = true;
    const shown = r.unknown.length
      ? r.unknown.map((k) => (nearest(k) ? `${k}（最接近的已知键：${nearest(k)}）` : k)).join(" / ")
      : "无";
    console.log(`  · ${c.label} → 已知 [${r.known.join(", ")}]，未知 [${shown}]`);
    check(
      r.unknown.join(",") === c.expect.join(","),
      `${c.label}：未知键判定 = [${c.expect.join(", ")}]（实际 [${r.unknown.join(", ")}]）`,
    );
  }
  check(listedAny, "集合外的 combo 键确实被逐项列名（不是静默忽略）");
  check(
    nearest("LIGHTINGX") === "LIGHTING",
    `负数夹具：拼错的键能指回最接近的已知键（LIGHTINGX → ${nearest("LIGHTINGX")}），列名可行动`,
  );

  // ---- 4) 真翻译器行为：「未知 combo 静默落默认档」的确切形状 ----
  const translate = (combos, src = SYNTH_FRAG) => hlsl2glsl(src, "frag", combos, () => null, "");
  const tKnown = translate({ LIGHTING: 1, CUTOUT: 0 });
  const tOff = translate({ LIGHTING: 0, CUTOUT: 1 });
  const tDefault = translate({});
  check(
    tKnown.includes("+= 1.0") && !tKnown.includes("+= 2.0") && !tKnown.includes("+= 4.0"),
    "真翻译器：材质 LIGHTING=1 / CUTOUT=0 → 走 #if 真分支、CUTOUT 段被剥掉",
  );
  check(
    !tOff.includes("+= 1.0") && tOff.includes("+= 2.0") && tOff.includes("+= 4.0"),
    "真翻译器：材质 LIGHTING=0 / CUTOUT=1 → 走 #else、CUTOUT 段保留（材质键确实起作用）",
  );
  check(tDefault === tKnown, "真翻译器：不给的键落 [COMBO] 声明的 default（LIGHTING default=1），输出与显式给 1 逐字符相同");
  const tUnused = translate({ LIGHTING: 1, CUTOUT: 0, FOO: 1 });
  check(
    tUnused === tKnown,
    "静默无操作：材质多给一个 shader 既不声明也不引用的键 FOO，hlsl2glsl 输出与不给**逐字符相同**" +
      "（只有程序缓存键 effectComboKey 会变，render/renderer.js:1364-1371）—— 引擎不会告诉作者「这个 combo 没用」",
  );
  // shader 引用了、但既无 [COMBO] 声明也没人提供
  const SYNTH_UNDECLARED = SYNTH_FRAG.replace('// [COMBO] {"combo":"LIGHTING","default":1}\n', "")
    .replace("#if LIGHTING", "#if FOO")
    .replace("float b = LIGHTING;", "float b = FOO;");
  let tUndeclared = null;
  let threw = null;
  try {
    tUndeclared = translate({}, SYNTH_UNDECLARED);
  } catch (e) {
    threw = e;
  }
  check(!threw, `未声明也未提供的 combo 不抛错（${threw ? threw.message : "ok"}）—— 引擎这一层没有诊断`);
  check(
    !!tUndeclared && !tUndeclared.includes("+= 1.0") && tUndeclared.includes("+= 2.0"),
    "……且 #if FOO 静默按 0 求值（走 #else），不留任何痕迹",
  );
  check(
    !!tUndeclared && /float b = FOO;/.test(tUndeclared),
    "反面对照：同一名字**裸用**在表达式里时不被替换、原样保留（不在 comboNames 里）→ 留给下游 GLSL 报「未声明标识符」" +
      "：这就是「#if 静默、裸用才炸」的不对称",
  );
  const tProvidedBare = translate({ FOO: 1 }, SYNTH_UNDECLARED.replace("#if FOO", "#if FOO == 0"));
  check(
    /float b = 1\.0;/.test(tProvidedBare),
    "对照：材质**给了** FOO 后，同一个裸用被替换成材质的数值（1.0）—— 未声明的键靠材质就能凭空生效，所以拼错才是事故",
  );
  const pv = preprocess("#if FOO\nAAA\n#else\nBBB\n#endif\n", {}, () => null, 0);
  check(
    /BBB/.test(pv) && !/AAA/.test(pv),
    "机制直证：preprocess 对未提供的 #if FOO 直接走 #else（render/hlsl-preprocessor.js:212 的 return '0'），不抛错",
  );
}

console.log(failed === 0 ? "\nverify-mat: 全部通过 ✓" : `\nverify-mat: ${failed} 项失败 ✗`);
process.exit(failed === 0 ? 0 : 1);
