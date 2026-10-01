/**
 * 一次性实测探针（2026-10-01 引擎审查用，非门禁）。
 *
 * 目的：把 docs/ENGINE-REVIEW-2026-10.md 里「靠静态推理」的几条结论
 * 用真实引擎代码量出来，再据此改方案。用法：
 *
 *   node scripts/_probe-review.mjs <name>      # 跑单个探针，打印一行 JSON
 *   node scripts/_probe-review.mjs driver      # 全部跑一遍（每个在子进程里 + 硬超时）
 *
 * 探针：
 *   sandbox     素材脚本能否逃出 new Function 的形参遮蔽、摸到真实全局
 *   tex-count   .tex 的 imageCount 无上界 → 实测每轮成本与外推
 *   tex-neg     .tex 的 compressedSize/uncompressedSize 为负 → 抛错还是静默
 *   tex-lz4     LZ4 目标尺寸无校验 + 解压是否惰性（决定闸门该放哪）
 *   particle-seq sequencemultiplier 的 n×n 帧表分配（128 上限是否在分配之前）
 *
 * 这是排障/取证工具，不进 verify 稳定集。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const imp = (rel) => import(new URL(`../${rel}`, import.meta.url).href);

const out = (o) => console.log(JSON.stringify(o));

/** 最小 TEXV0005 / TEXI0001 / TEXB0003 容器，字段全由参数决定（默认全部合法）。 */
function buildTex({
  imageCount = 1,
  mipCount = 1,
  mw = 4,
  mh = 4,
  compression = 0,
  uncompressedSize = 0,
  compressedSize = 0,
  payload = Buffer.alloc(0),
  flags = 0,
} = {}) {
  const head = Buffer.alloc(46);
  head.write("TEXV0005\0", 0, "latin1");
  head.write("TEXI0001\0", 9, "latin1");
  head.writeUInt32LE(0, 18); // format
  head.writeUInt32LE(flags, 22);
  head.writeUInt32LE(4, 26); // textureWidth
  head.writeUInt32LE(4, 30); // textureHeight
  head.writeUInt32LE(4, 34); // width（containerOffset-12）
  head.writeUInt32LE(4, 38); // height（containerOffset-8）
  head.writeUInt32LE(0, 42); // ignored
  const body = Buffer.alloc(17);
  body.write("TEXB0003\0", 0, "latin1");
  body.writeUInt32LE(imageCount, 9);
  body.writeUInt32LE(0, 13); // freeImageFormat
  const mips = Buffer.alloc(24);
  mips.writeUInt32LE(mipCount, 0);
  mips.writeUInt32LE(mw, 4);
  mips.writeUInt32LE(mh, 8);
  mips.writeUInt32LE(compression, 12);
  mips.writeInt32LE(uncompressedSize, 16);
  mips.writeInt32LE(compressedSize, 20);
  return Buffer.concat([head, body, mips, payload]);
}

const PROBES = {
  // ───────────────────────── 1. 脚本沙箱边界 ─────────────────────────
  async sandbox() {
    const { evalTextScript } = await imp("renderer/vendor/we-scene/render/text.js");
    const vectors = {
      // 直接引用被遮蔽的全局：应当拿不到（对照组，证明确实遮蔽了）
      direct: `function update(){return typeof window + '|' + typeof fetch}`,
      // 从函数对象自身的 constructor 反推 Function —— 形参遮蔽管不到
      fnCtor: `function update(){}
        var g = (function(){}).constructor('return this')(); g.__probeFnCtor = true;`,
      // 数组字面量的 constructor 链
      arrCtor: `function update(){}
        var g = [].constructor.constructor('return this')(); g.__probeArrCtor = true;`,
      // 间接 eval（严格模式下 (0,eval) 是全局作用域 eval）
      indirEval: `function update(){}
        var g = (0,eval)('this'); if (g) g.__probeIndirEval = true;`,
    };
    const result = {};
    for (const [name, script] of Object.entries(vectors)) {
      const flag = `__probe${name[0].toUpperCase()}${name.slice(1)}`;
      delete globalThis[flag];
      let err = null;
      try {
        evalTextScript(script, {}, {});
      } catch (e) {
        err = String(e && e.message ? e.message : e).slice(0, 120);
      }
      result[name] = { reachedGlobal: globalThis[flag] === true, err };
      delete globalThis[flag];
    }
    // 顺带确认对照组里直接引用确实是 undefined（遮蔽生效）
    let directTypes = null;
    try {
      const sb = evalTextScript(`function update(){return typeof window + '/' + typeof fetch}`, {}, {});
      directTypes = sb && sb.update ? sb.update() : null;
    } catch {
      /* 无 update 返回路径时留 null */
    }
    out({ probe: "sandbox", vectors: result, directTypesInSandbox: directTypes });
  },

  // ───────────────────── 2. imageCount 无上界（循环/内存） ─────────────────────
  async texCount() {
    const { parseTex } = await imp("renderer/vendor/we-scene/pkg/texture.js");
    const N = Number(process.argv[3] || 200000);
    const buf = buildTex({ imageCount: N, mipCount: 0, compressedSize: 0 });
    const t0 = Date.now();
    const r = parseTex(buf);
    const ms = Date.now() - t0;
    const heap = process.memoryUsage().heapUsed;
    const perIterUs = (ms * 1000) / N;
    const full = 0xffffffff;
    out({
      probe: "tex-count",
      measuredImageCount: N,
      ms,
      heapUsedMB: +(heap / 1048576).toFixed(1),
      imagesParsed: r.images ? r.images.length : null,
      perIterationUs: +perIterUs.toFixed(3),
      extrapolatedFullCountMs: Math.round((perIterUs * full) / 1000),
      extrapolatedFullCountHeapGB: +(((heap / N) * full) / 2 ** 30).toFixed(1),
    });
  },

  // ─────────────────── 3. 负尺寸字段（静默还是抛错） ───────────────────
  async texNeg() {
    const { parseTex } = await imp("renderer/vendor/we-scene/pkg/texture.js");
    const only = process.argv[3] || null;
    const cases = {
      // compressedSize = -1 → 期望：要么抛，要么 p 回退后继续读垃圾
      negCompressed: buildTex({ imageCount: 1, mipCount: 1, compression: 0, compressedSize: -1 }),
      // compression=1 且 uncompressedSize = -1 → 惰性解压，读取时才炸
      negUncompressed: buildTex({ imageCount: 1, mipCount: 1, compression: 1, uncompressedSize: -1, compressedSize: 4 }),
      // mipCount 巨大但载荷截断 → 越界读返回 0 会让循环空转到何时（这条会 OOM，放最后）
      hugeMipCount: buildTex({ imageCount: 1, mipCount: 0xffffffff, compressedSize: 0 }),
    };
    // 每个 case 单独打一行：最后一条 OOM 崩掉时，前面的结果仍在 stdout
    for (const [name, buf] of Object.entries(cases)) {
      if (only && only !== name) continue;
      const t0 = Date.now();
      let parsed = null;
      let err = null;
      try {
        const r = parseTex(buf);
        parsed = {
          images: r.images.length,
          mips0: r.images[0] ? r.images[0].length : null,
          firstMipWH: r.images[0] && r.images[0][0] ? [r.images[0][0].width, r.images[0][0].height] : null,
        };
      } catch (e) {
        err = String(e && e.message ? e.message : e).slice(0, 120);
      }
      // 惰性路径：读 .data 才会真正解压
      let dataErr = null;
      let dataLen = null;
      if (parsed && !err) {
        try {
          const r = parseTex(buf);
          const m = r.images[0] && r.images[0][0];
          if (m) dataLen = m.data.length;
        } catch (e) {
          dataErr = String(e && e.message ? e.message : e).slice(0, 120);
        }
      }
      out({ probe: "tex-neg", case: name, ms: Date.now() - t0, parsed, err, dataLen, dataErr });
    }
  },

  // ─────────────────── 4. LZ4 目标尺寸无校验 + 惰性 ───────────────────
  async texLz4() {
    const { lz4Decompress } = await imp("renderer/vendor/we-scene/pkg/tex-codecs.js");
    const { parseTex } = await imp("renderer/vendor/we-scene/pkg/texture.js");
    const MB = Number(process.argv[3] || 256);
    const outSize = MB * 1048576;

    // (a) 原语：2 字节输入 → 声明 256MB 输出，看是否直接分配、耗时多少
    const before = process.memoryUsage();
    const t0 = Date.now();
    let primErr = null;
    let len = null;
    try {
      len = lz4Decompress(Buffer.from([0x00, 0x00]), outSize).length;
    } catch (e) {
      primErr = String(e && e.message ? e.message : e).slice(0, 140);
    }
    const primMs = Date.now() - t0;
    const after = process.memoryUsage();

    // (b) 真实解析路径：声明 256MB 的 mip，parseTex 是否立刻分配（惰性则很快返回）
    const big = buildTex({ imageCount: 1, mipCount: 1, compression: 1, uncompressedSize: outSize, compressedSize: 4, payload: Buffer.from([0x00, 0x00, 0x00, 0x00]) });
    const t1 = Date.now();
    let parseMs = null;
    let parseErr = null;
    let lazyData = null;
    try {
      const r = parseTex(big);
      parseMs = Date.now() - t1;
      lazyData = r.images[0][0].data.length; // 真正触发解压
    } catch (e) {
      parseErr = String(e && e.message ? e.message : e).slice(0, 140);
    }
    out({
      probe: "tex-lz4",
      requestedMB: MB,
      primitive: {
        returnedLength: len,
        ms: primMs,
        err: primErr,
        rssDeltaMB: +((after.rss - before.rss) / 1048576).toFixed(1),
      },
      viaParseTex: {
        parseMs, // 小 = 惰性（解析期不分配）
        parseErr,
        dataLenOnRead: lazyData,
        totalMs: Date.now() - t1,
      },
    });
  },

  // ─────────────── 5. sequencemultiplier 的 n×n 帧表 ───────────────
  async particleSeq() {
    const { ParticleSystem } = await imp("renderer/vendor/we-scene/render/particles.js");
    const mul = Number(process.argv[3] || 3000);
    const ps = new ParticleSystem(null, { sequencemultiplier: mul }, {}, null);
    const t0 = Date.now();
    let err = null;
    let arrLen = null;
    try {
      const fd = ps._frameUniformData();
      arrLen = fd ? fd.length : null;
    } catch (e) {
      err = String(e && e.message ? e.message : e).slice(0, 140);
    }
    const ms = Date.now() - t0;
    const n = mul;
    out({
      probe: "particle-seq",
      sequenceMul: mul,
      productNxN: n * n,
      ms,
      perMillionMs: +((ms / ((n * n) / 1e6))).toFixed(2),
      frameUniformFloats: arrLen,
      err,
      extrapolated100kMs: Math.round((ms / (n * n)) * (100000 * 100000)),
    });
  },
};

// ───────────────────────────── driver ─────────────────────────────
async function driver() {
  // [名字, 超时ms, 透传给探针的参数]；危险的用例各自独占一个子进程
  const plan = [
    ["sandbox", 20000, null],
    ["texCount", 20000, "200000"], // 小样本测速率，外推到全量
    ["texNeg", 20000, "negCompressed"], // 安全用例
    ["texNeg", 20000, "negUncompressed"], // 安全用例
    ["texLz4", 30000, null],
    ["particleSeq", 20000, "3000"], // 小样本测速率，外推到 100000
    ["texNeg", 20000, "hugeMipCount"], // 会 OOM，独占
    ["texCount", 15000, "4294967295"], // 全量 imageCount，超时即证「不可终止」
  ];
  const report = {};
  for (const [name, timeout, arg] of plan) {
    const argv = [fileURLToPath(import.meta.url), name];
    if (arg !== null) argv.push(arg);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, argv, {
      timeout,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    // 全部可解析的 JSON 行都收（OOM 崩掉时前面的结果仍在 stdout）
    const results = (r.stdout || "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const key = arg ? `${name}:${arg}` : name;
    report[key] = {
      wallMs: Date.now() - t0,
      killedByTimeout: r.signal === "SIGTERM" || r.error?.code === "ETIMEDOUT",
      exitCode: r.status,
      signal: r.signal || null,
      results,
      stderrTail: (r.stderr || "").trim().split("\n").slice(-2).join(" | ").slice(0, 400) || null,
    };
  }
  out({ probe: "driver", root: ROOT, report });
}

const name = process.argv[2];
// CLI 兼收 kebab 别名，方便逐条手跑
const ALIAS = { "tex-count": "texCount", "tex-neg": "texNeg", "tex-lz4": "texLz4", "particle-seq": "particleSeq" };
if (name === "driver") {
  await driver();
} else if (PROBES[name] || PROBES[ALIAS[name]]) {
  await PROBES[PROBES[name] ? name : ALIAS[name]]();
} else {
  console.error(`用法: node scripts/_probe-review.mjs <driver|${Object.keys(PROBES).join("|")}>`);
  process.exit(2);
}
