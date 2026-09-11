/**
 * verify-groups.mjs —— 「层内容取错」这一类缺陷的离线校验
 *
 * A/B 是 3264246690 暴露的两个「效果链层内容矩形」缺陷，
 * D/E 是同一类的另外两种形态（层内容压根没解出来 / 层内容该是背后画面）：
 *
 *   A. puppet 的效果链跑在**贴图空间**，网格形变在链尾
 *      旧实现先把蒙皮网格渲进 FBO、再把效果盖在形变后的画面上（并为此把 FBO
 *      矩形扩成 layerRect ∪ meshBounds）。方向是反的：3148125112 的白丝贴图
 *      materials/腿2.tex 有 100.0% 的不透明像素落在 materials/腿1.tex 的不透明
 *      像素内 —— 两张图在**未形变的贴图空间**逐像素对齐；同层的 waterwaves /
 *      opacity 蒙版又都是 1286×1148 = 层尺寸的一半，按层矩形归一化。这些资源
 *      全部作于静止姿势，必须先在贴图上合成、再由网格整体形变。旧顺序把平整的
 *      丝袜贴到已经抬腿的画面上，只能糊出一条错位白带。
 *      网格 UV 与静止姿势位置严格对应（u=(x+W/2)/W、v=(H/2-y)/H），所以
 *      「贴图空间」就是「层矩形空间」，与蒙版基准天然一致，FBO 不需要再扩。
 *
 *   B. 带子层的容器（组渲染目标）此前被整个跳过
 *      composelayer 是画布，子层画在画布上，容器的效果作用于整块画布。
 *      渲染器原先「带子层的容器一律 continue」，于是容器上挂的效果全部失效 ——
 *      3264246690 三条 DANGER 胶带挂的是 scroll(speedx 0.1)，表现为完全静止。
 *      全库 15 个这类容器 / 9 个壁纸。
 *      修复的坑：parse 阶段已把父变换合并进子层，画子层进组 FBO 前必须
 *      **除掉容器那一份**，否则 scale/rotate 施加两遍（实测胶带粗一倍、倾角翻倍）。
 *      补记：childIds 只有直接孩子。3787937755 眼睛/手挂在身子下，组容器
 *      1361 的 childIds 只有身子；只收直接子层时 depthparallax 只扭曲脸、
 *      眼睛钉在世界坐标上随视差单独滑。必须递归收孙层。
 *
 *   C. A/B 的实现接线（防止改回原样）
 *
 *   D. TEXB0004 的 V4 逐 mip 扩展块被按「是不是 mp4」误判
 *      少跳 34 字节 → mw/mh 读成 1/0 → 解码失败 → 图层拿不到 textureName。
 *      3789790717 因此只剩 clearcolor 灰底 + 唯一那张 mp4 贴图。
 *
 *   E. config.passthrough：层的效果链输入应是**背后已渲染的画面**
 *      给空画布会让工坊音频可视化的 rgb 完全不含 bar 形状。
 *      3789131791「Green」糊出一块 1920×1080 青色矩形。
 *
 *   F. composelayer 被当成 solidlayer
 *      前者是效果画布（层内容应为空白），后者才是纯色层。混同后 17 个带 solid
 *      残留的 composelayer 拿到纯白底，2872267921「音频」糊出不透明白屏。
 *
 *   G. MDL 顶点布局 + 视锥裁剪的动画位移余量
 *      MDLV0013 的 lenOff=4、stride=52；新版 MDLV0023 puppet 还有 stride=84
 *      （3797270925）。视锥裁剪只看静态 origin，而 puppet 是被骨骼动画推着走的：
 *      「停在屏外、靠动画开进画面」的层会被每帧裁掉（2477602742 火车）。
 *
 *   H. 图层混合：Screen/Multiply 丢掉 src 不透明度；效果 FBO 名不一定有 _rt_ 前缀
 *      colorBlendMode=7 的 Screen 层、mode=2 的 Multiply 层，原实现直接用
 *      blendFunc(ONE, ONE_MINUS_SRC_COLOR)，src.a 完全没参与 —— 半透明层按
 *      全不透明盖下去。3789462324「Clouds Back」实际 opacity≈0.13 却把人物脸全糊住。
 *      另一条：resolveTextureName 只对 _rt_ 前缀的名字查 effectFBOs，工坊效果的
 *      裸名 FBO（bloom 的 blur_start_2 等）落到贴图表 → 查不到 → 白纹理兜底 →
 *      多 pass 效果从中间断链，尾灯高光被糊成纯白方块。
 *
 *   K. fullscreenlayer / projectlayer 被整层跳过
 *      973101892 的星云动画在 Fullscreen 的 waterripple/pulse/godrays。
 *      旧实现 `if (layer.isPostProcess) continue`，装配又因 pkg 无内置 json
 *      而跳过效果解析；作者 size 还是编辑器预览框。
 *
 *   L. copy 命令画 TRIANGLE_STRIP 4：PASS_QUAD 是 6 顶点三角形列表，
 *      只拷半块对角。1444077782 两条 fullscreen motionblur 叠出左侧硬边白三角。
 *
 * 退出码非 0 表示发现问题。
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker, dec } from "./lib/verify-kit.mjs";
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseMDL, computeSkinMatrices } = await imp("renderer/vendor/we-scene/render/mdl.js");
const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
// 视锥裁剪的 puppet 动画余量 / 图层混合：H、G 区块直接调这两份实现做回归（不在测试里另写一遍）
const { puppetAnimMargin, applyColorBlendCPU, layerWantsPreserveBackdrop, collectGroupDescendantIds, layerCompositeBlendMode } = await imp("renderer/vendor/we-scene/render/renderer.js");

const { check, errors } = createChecker();
const readJson = (pkg, name) => {
  try { const e = getEntry(pkg, name); return e ? JSON.parse(dec.decode(e)) : null; }
  catch (e) { return null; }
};

const wallpapers = [];
for (const id of fs.readdirSync(LIB)) {
  const p = join(LIB, id, "scene.pkg");
  if (!fs.existsSync(p)) continue;
  try {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(p)));
    const scene = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
    wallpapers.push({ id, pkg, scene });
  } catch (e) { /* 非法包跳过 */ }
}
check(wallpapers.length > 100, `壁纸库样本过少: ${wallpapers.length}`);

// ---------- A. puppet 网格包围盒 ----------
{
  let total = 0, clipped = 0, clippedWithEffects = 0;
  const worst = [];
  for (const { id, pkg, scene } of wallpapers) {
    for (const o of scene.objects || []) {
      if (typeof o.image !== "string") continue;
      const mj = readJson(pkg, o.image);
      if (!mj || !mj.puppet) continue;
      let mdl;
      try { mdl = parseMDL(getEntry(pkg, mj.puppet)); } catch (e) { continue; }
      const b = mdl && mdl.bounds;
      if (!b) continue;
      total++;
      const size = String(o.size || "0 0").trim().split(/\s+/).map(Number);
      const [sw, sh] = [size[0] || 0, size[1] || 0];
      const inW = Math.max(0, Math.min(b.maxX, sw / 2) - Math.max(b.minX, -sw / 2));
      const inH = Math.max(0, Math.min(b.maxY, sh / 2) - Math.max(b.minY, -sh / 2));
      const area = (b.maxX - b.minX) * (b.maxY - b.minY);
      const keep = area > 0 ? (inW * inH) / area : 1;
      if (keep < 0.999) {
        clipped++;
        const nEff = (o.effects || []).filter((e) => e.visible !== false).length;
        if (nEff > 0) clippedWithEffects++;
        worst.push({ id, name: o.name, keep, nEff });
      }
    }
  }
  worst.sort((a, b) => a.keep - b.keep);
  console.log(`【A. puppet 包围盒】共 ${total} 个 puppet，其中 ${clipped} 个网格超出 layer.size 居中矩形`);
  console.log(`   超出且挂了效果（走 FBO 路径、会被真裁掉）：${clippedWithEffects} 个`);
  for (const w of worst.slice(0, 4)) {
    console.log(`   ${(w.keep * 100).toFixed(1)}%  ${w.id} ${JSON.stringify(w.name)} eff=${w.nEff}`);
  }
  // 这批样本是本次修复的依据；若归零说明 parseMDL.bounds 失效或库变了
  check(total >= 100, `puppet 样本数异常: ${total}（预期 ≥100）`);
  check(clippedWithEffects >= 40, `「网格越界且有效果」样本异常偏低: ${clippedWithEffects}（预期 ≥40）`);

  // A2. 判定「效果链该在贴图空间」的那条硬证据：3148125112 的丝袜贴图与光腿贴图
  // 在**未形变的贴图空间**逐像素对齐。若某天这个比例掉下来，说明素材约定变了，
  // 贴图空间合成的前提就不再成立 —— 那时必须重新判断顺序，而不是照旧。
  {
    const t = wallpapers.find((w) => w.id === "3148125112");
    if (!t) {
      console.log("   ⚠ 3148125112 不在库中，跳过丝袜对齐检查");
    } else {
      const { parseTex, decodeMip0 } = await imp("renderer/vendor/we-scene/pkg/texture.js");
      const png = (n) => {
        const e = getEntry(t.pkg, `materials/${n}.tex`);
        if (!e) return null;
        const m = decodeMip0(parseTex(e));
        return m && m.png ? { w: m.width, h: m.height, png: m.png } : null;
      };
      const bare = png("腿1"), white = png("腿2");
      if (!bare || !white) {
        errors.push("3148125112 腿1/腿2 贴图解码失败（丝袜对齐检查无法进行）");
      } else {
        check(bare.w === white.w && bare.h === white.h,
          `腿1(${bare.w}x${bare.h}) 与 腿2(${white.w}x${white.h}) 尺寸应一致`);
        // 层尺寸就是贴图尺寸 ⇒ 贴图空间 == 层矩形空间（蒙版按层矩形归一化才成立）
        const o = (t.scene.objects || []).find((x) => x.name === "腿1");
        const sz = String((o && o.size) || "0 0").trim().split(/\s+/).map(Number);
        check(Math.round(sz[0]) === bare.w && Math.round(sz[1]) === bare.h,
          `腿1 层尺寸 ${sz[0]}x${sz[1]} 应等于贴图尺寸 ${bare.w}x${bare.h}`);
        console.log(`   样本 3148125112：腿1/腿2 贴图 ${bare.w}x${bare.h} = 层尺寸，丝袜与光腿共用同一贴图坐标系`);
      }
    }
  }

  // 具体样本：3264246690 的头部越界量必须仍然可复现
  const target = wallpapers.find((w) => w.id === "3264246690");
  if (target) {
    const o = (target.scene.objects || []).find((x) => x.name === "1拆分");
    const mj = o && readJson(target.pkg, o.image);
    const mdl = mj && mj.puppet ? parseMDL(getEntry(target.pkg, mj.puppet)) : null;
    if (mdl) {
      const b = mdl.bounds;
      check(Math.round(b.maxY) === 1610, `3264246690「1拆分」网格顶应为 1610，实际 ${b.maxY}`);
      check(b.maxY > 1000, "3264246690「1拆分」网格顶必须超过层顶 1000（否则样本失去意义）");
      console.log(`   样本 3264246690「1拆分」：网格 y ∈ [${Math.round(b.minY)}, ${Math.round(b.maxY)}]，层矩形 y ∈ [-1000, 1000]`);
    } else {
      errors.push("3264246690「1拆分」puppet 解析失败");
    }
  } else {
    errors.push("壁纸库缺少样本 3264246690");
  }
}

// ---------- B. 组渲染目标（带子层 + 有效果的容器） ----------
{
  let nContainer = 0;
  const byWp = new Set();
  const samples = [];
  for (const { id, scene } of wallpapers) {
    const objs = scene.objects || [];
    const kidCount = new Map();
    for (const o of objs) if (o.parent != null) kidCount.set(o.parent, (kidCount.get(o.parent) || 0) + 1);
    for (const o of objs) {
      if (typeof o.image !== "string" || o.image.indexOf("models/util/composelayer") !== 0) continue;
      const kids = kidCount.get(o.id) || 0;
      const effs = (o.effects || []).filter((e) => e.visible !== false);
      if (kids > 0 && effs.length > 0) {
        nContainer++;
        byWp.add(id);
        samples.push({ id, name: o.name, kids, effs: effs.length });
      }
    }
  }
  console.log(`【B. 组渲染目标】带子层且有可见效果的容器 ${nContainer} 个 / ${byWp.size} 个壁纸`);
  for (const s of samples.slice(0, 4)) console.log(`   ${s.id} ${JSON.stringify(s.name)} kids=${s.kids} eff=${s.effs}`);
  check(nContainer >= 12, `组渲染目标容器数异常偏低: ${nContainer}（预期 ≥12）`);

  // parse 必须给出 childIds，渲染器才能按容器聚起子层
  const t = wallpapers.find((w) => w.id === "3264246690");
  if (t) {
    const proj = JSON.parse(fs.readFileSync(join(LIB, t.id, "project.json"), "utf8"));
    const parsed = parseScene(t.scene, proj);
    const band = parsed.layers.find((l) => l.id === 586);
    check(!!band, "3264246690 缺少容器层 586");
    if (band) {
      check(band.isContainer && band.hasChildren, "586 应是带子层的容器");
      check(Array.isArray(band.childIds) && band.childIds.length === 3,
        `586.childIds 应有 3 个子层，实际 ${JSON.stringify(band.childIds)}`);
      // 子层的世界变换已合并父级：这正是渲染组 FBO 时必须反解的原因
      const kid = parsed.layers.find((l) => l.id === 41);
      check(!!kid && kid.parentId === 586, "41 的 parentId 应为 586");
      if (kid) {
        check(Math.abs(kid.scale[0] - band.scale[0]) < 1e-6,
          `子层 scale 应已并入父级 ${band.scale[0]}，实际 ${kid.scale[0]}`);
        check(Math.abs(kid.angles[2] - band.angles[2]) < 1e-6,
          `子层 angle 应已并入父级 ${band.angles[2]}，实际 ${kid.angles[2]}`);
        console.log(`   样本 586「${band.name}」：kids=${band.childIds.length}，子层已继承 scale=${kid.scale[0]} angle=${kid.angles[2]}`);
      }
    }
  }

  // 3787937755：组容器的 childIds 只有身子，眼睛/手是孙层。
  // 只 `add(childIds)` 会把眼睛留在主循环，depthparallax/shake 只作用在脸上。
  const eyesWp = wallpapers.find((w) => w.id === "3787937755");
  if (eyesWp) {
    const proj = JSON.parse(fs.readFileSync(join(LIB, eyesWp.id, "project.json"), "utf8"));
    const parsed = parseScene(eyesWp.scene, proj);
    const byId = new Map(parsed.layers.map((l) => [l.id, l]));
    const gojo = parsed.layers.find((l) => l.id === 1361);
    const sukuna = parsed.layers.find((l) => l.id === 277);
    check(!!gojo && !!sukuna, "3787937755 缺少组容器 1361 / 277");
    if (gojo) {
      check(Array.isArray(gojo.childIds) && gojo.childIds.includes(68) && !gojo.childIds.includes(1115),
        `1361.childIds 应只有身子 68、不含眼睛 1115（样本失效则孙层结构变了），实际 ${JSON.stringify(gojo.childIds)}`);
      const ids = collectGroupDescendantIds(gojo, byId);
      check(ids.has(68) && ids.has(1115) && ids.has(72),
        `1361 递归应收 68/1115/72，实际 ${[...ids].join(",")}`);
      check(!new Set(gojo.childIds || []).has(1115),
        "1115 若出现在 1361.childIds 里，本条「只收直接孩子会漏眼睛」的护栏就失效了");
      console.log(`   样本 1361「${gojo.name}」：direct=${JSON.stringify(gojo.childIds)} descendants=${[...ids].join(",")}`);
    }
    if (sukuna) {
      check(Array.isArray(sukuna.childIds) && sukuna.childIds.includes(696) && !sukuna.childIds.includes(707),
        `277.childIds 应只有身子 696、不含眼睛 707，实际 ${JSON.stringify(sukuna.childIds)}`);
      const ids = collectGroupDescendantIds(sukuna, byId);
      check(ids.has(696) && ids.has(707) && ids.has(710),
        `277 递归应收 696/707/710，实际 ${[...ids].join(",")}`);
    }
  }
}

// ---------- C. 实现必须真的接线 ----------
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");

  // A 的接线：puppet 的效果链跑在**贴图空间**，网格形变留到链尾
  //
  // 旧实现是「先蒙皮渲进 FBO、再把效果盖在形变后的画面上」，并为此把 FBO 矩形
  // 扩成 layerRect ∪ meshBounds。方向是反的：3148125112 的白丝贴图
  // materials/腿2.tex 有 100.0% 的不透明像素落在 materials/腿1.tex 的不透明像素内，
  // 两张图在**未形变的贴图空间**逐像素对齐；同层的 waterwaves / opacity 蒙版
  // 又都是 1286×1148 = 层尺寸的一半，按层矩形归一化。这些资源全部作于静止姿势，
  // 必须先在贴图上合成、再由网格整体形变，否则平整的丝袜贴到已抬腿的画面上
  // 只能糊出一条错位白带。
  check(!/function drawPuppetToFBO/.test(rsrc),
    "drawPuppetToFBO 又回来了：puppet 的效果链必须跑在贴图空间，不能先把网格渲进 FBO");
  check(/function drawPuppetDirect\([^)]*overrideTex/.test(rsrc),
    "drawPuppetDirect 未接收 overrideTex（网格采样不到效果链输出，丝袜切换失效）");
  check(/drawPuppetDirect\(layer, cam, viewProj, width, height, time, curInput\.tex\)/.test(rsrc),
    "效果链末尾未把 curInput.tex 交给 drawPuppetDirect（puppet 会被当平面 quad 贴回去）");

  // puppet 的 copy pass 必须先失效 quad 缓存：MDL 渲染器换过 VAO/VBO，
  // 沿用缓存键会拿着 MDL 的顶点缓冲去画层 quad（实测人物碎成一片）。
  const cpStart = rsrc.indexOf("if (isPuppet) {", rsrc.indexOf("const layerOrtho"));
  const cpCode = cpStart >= 0 ? rsrc.slice(cpStart, cpStart + 1600) : "";
  check(/currentQuadKey = null[\s\S]{0,240}uploadQuad\('layer'/.test(cpCode),
    "puppet 的 copy pass 未在 uploadQuad 前失效 quad 缓存（会复用 MDL 的顶点缓冲，人物碎裂）");

  // mdl.js：overrideTex 必须真的成为采样源；且不能翻 v。
  // 层 FBO 由 v=1 的顶点写入 NDC 顶，采样恒有 FBO(v) == 源贴图(v)，UV 是恒等的；
  // 翻了会让腿采样到空白区直接消失（实测双腿整条不见）。
  {
    // draw/overrideTex 在 mdl.js 渲染段（engineering/modularization 拆分后仍留在本文件）
    const msrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl.js"), "utf8");
    check(/opts\.overrideTex\s*\|\|/.test(msrc),
      "mdl.js 的 draw 未优先采样 overrideTex（效果链输出被忽略）");
    check(!/u_flipV/.test(msrc) && !/1\.0 - v_uv\.y/.test(msrc),
      "mdl.js 翻转了 v：层 FBO 的 UV 是恒等的，翻了网格会采样到空白区");
  }

  // B 的接线：组渲染目标
  check(/function renderContainerGroup/.test(rsrc),
    "renderer.js 未实现 renderContainerGroup（带子层容器的效果仍整组失效）");
  check(/groupTarget/.test(rsrc), "缺少 groupTarget（子层合成写不进组 FBO）");
  check(/layer\.groupTex/.test(rsrc), "容器未把组图当作层内容（groupTex）");
  // 必须反解容器自身变换，否则 scale/rotate 施加两遍
  const gStart = rsrc.indexOf("function renderContainerGroup");
  const gCode = rsrc.slice(gStart, gStart + 3000).replace(/\/\/[^\n]*/g, "");
  check(/\/\s*csx/.test(gCode) && /\/\s*csy/.test(gCode),
    "renderContainerGroup 必须把子层 scale 除以容器 scale（否则缩放施加两遍）");
  check(/savedAngles\[2\]\s*-\s*cang/.test(gCode),
    "renderContainerGroup 必须把子层 angle 减去容器 angle（否则旋转施加两遍）");
  // 组容器不能走「空容器 alpha 语义」那套判定
  check(/!layer\.groupTex/.test(rsrc),
    "组渲染容器必须绕开空容器的 alpha 判定（否则按加法糊上去）");
  // 孙层：主循环跳过集合和组 FBO 绘制都必须走 collectGroupDescendantIds，
  // 只 `for (const k of kids) groupChildIds.add(k)` 会把 3787937755 的眼睛漏在组外。
  check(/function collectGroupDescendantIds/.test(rsrc),
    "缺少 collectGroupDescendantIds（组渲染仍只收直接 childIds）");
  check(/collectGroupDescendantIds\(\s*layer,/.test(rsrc),
    "主循环 groupChildIds 未调用 collectGroupDescendantIds");
  check(/collectGroupDescendantIds\(\s*container,/.test(gCode),
    "renderContainerGroup 必须按子孙画进组 FBO，不能只滤直接 childIds");

  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  check(/childIds/.test(psrc), "parse.js 未产出 childIds");
  check(/parentId/.test(psrc), "parse.js 未产出 parentId");
}

// ---------- D. TEXB0004 的 V4 逐 mip 扩展布局 ----------
//
// TEXB0004 头里 freeImageFormat 之后那个 u32 是 **V4 扩展块的开关**，不是「是不是 mp4」。
// 扩展块（param1/param2 + condition JSON + param3）是编辑器给单张 mip 挂显隐条件用的，
// 与图像格式无关。原实现读成 isMp4、只有 MP4 才按 V4 解析，于是 JPEG/PNG 但带扩展块的
// 贴图会少跳 34 字节：mw/mh 读成 1/0、图像数据从 JSON 中间开始截 → 解码失败 →
// 图层拿不到 textureName。3789790717 因此只剩 clearcolor 灰底 + 唯一那张 mp4 贴图。
{
  const u32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  const ascii = (b, p, n) => String.fromCharCode(...b.slice(p, p + n));
  const latin1 = new TextDecoder("latin1");
  let nTex = 0, nB4 = 0, nV4 = 0, layoutBad = 0;
  const conds = new Set();
  const samples = [];
  for (const { id, pkg } of wallpapers) {
    for (const e of pkg.entries) {
      if (!e.name.endsWith(".tex")) continue;
      let b;
      try { b = getEntry(pkg, e.name); } catch (err) { continue; }
      if (!b || b.length < 130 || ascii(b, 0, 8) !== "TEXV0005") continue;
      nTex++;
      if (ascii(b, 46, 8) !== "TEXB0004") continue;
      nB4++;
      if (u32(b, 63) !== 1) continue;
      nV4++;
      // 按 V4 布局往下读，mipCount / mw / mh 必须与头部一致
      let p = 67;
      const mipCount = u32(b, p); p += 4;
      p += 8;                       // param1 / param2
      const js = p;
      while (p < b.length && b[p] !== 0) p++;
      conds.add(latin1.decode(b.slice(js, p)));
      p += 1 + 4;                   // JSON 的 null + param3
      const mw = u32(b, p), mh = u32(b, p + 4);
      const texW = u32(b, 26), texH = u32(b, 30);
      const ok = mipCount >= 1 && mipCount <= 20 && mw === texW && mh === texH;
      if (!ok) layoutBad++;
      samples.push({ id, name: e.name, ok, mipCount, mw, mh, texW, texH });
    }
  }
  console.log(`【D. TEXB0004 V4 布局】${nTex} 张 .tex / ${nB4} 张 TEXB0004，其中带 mip 扩展块 ${nV4} 张`);
  console.log(`   扩展块里的 condition: ${[...conds].join(", ")}`);
  for (const s of samples) {
    console.log(`   ${s.ok ? "✓" : "✗"} ${s.id} ${s.name} mip=${s.mipCount} ${s.mw}x${s.mh} (头部 ${s.texW}x${s.texH})`);
  }
  check(nTex > 1500, `.tex 样本过少: ${nTex}`);
  check(nV4 >= 4, `带 V4 扩展块的贴图样本异常偏低: ${nV4}（预期 ≥4）`);
  check(layoutBad === 0, `${layoutBad} 张按 V4 布局解析后 mipCount/尺寸与头部不符`);

  // 端到端：这 4 张必须真的能解出与头部一致的图像，而不是 1x0
  const { parseTex, decodeMip0 } = await imp("renderer/vendor/we-scene/pkg/texture.js");
  for (const s of samples) {
    const wp = wallpapers.find((w) => w.id === s.id);
    try {
      const t = parseTex(getEntry(wp.pkg, s.name));
      const m = decodeMip0(t);
      const kind = m.video ? "video" : m.png ? "png" : m.image ? `img${m.fif}` : m.rgba ? "rgba" : "?";
      check(m.width === s.texW && m.height === s.texH,
        `${s.id}/${s.name} 解出 ${kind}:${m.width}x${m.height}，应为 ${s.texW}x${s.texH}（V4 扩展块没跳过 → 数据从 JSON 中间截）`);
    } catch (err) {
      errors.push(`${s.id}/${s.name} parseTex 抛错: ${err.message}`);
    }
  }

  // 接线本身：不得退回「按 MP4 判 V4」
  const tsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/pkg/texture.js"), "utf8")
    .replace(/\/\/[^\n]*/g, "");
  check(!/containerVersion\s*=\s*freeImageFormat\s*===\s*FIF\.MP4\s*\?\s*4\s*:\s*3/.test(tsrc),
    "V4 布局不能由 freeImageFormat===MP4 决定（JPEG/PNG 也会带 mip 扩展块）");
  check(/containerVersion\s*=\s*hasMipExtension\s*===\s*1\s*\?\s*4\s*:\s*3/.test(tsrc),
    "V4 布局必须由 TEXB0004 头里那个扩展块开关决定");
}

// ---------- E. config.passthrough（层背后画面作为效果链输入）----------
//
// WE 用 `config.passthrough` 声明「本层的效果链输入 = 它背后已渲染的画面」。
// 渲染器原先一律给一块空画布，对工坊音频可视化是致命的 —— 那类着色器普遍写成
//   finalColor = ApplyBlending(MODE, lerp(barColor, scene.rgb, scene.a), barColor, bar*op)
// 空画布下 scene=(0,0,0,0)，lerp 在两参相同时恒等返回 barColor，
// **rgb 完全不含 bar 形状**；形状只能靠 alpha。TRANSPARENCY=REPLACE 的还有
// alpha 兜底（compositeLayer 的 [A]/[B] 判定），PRESERVE（alpha = scene.a = 0）
// 连 alpha 都没有 → 整块 quad 成恒定纯色。3789131791「Green」即 1920×1080 青色矩形。
{
  let nPass = 0, nCtr = 0, nEmptyEff = 0, nRot = 0, nNegScale = 0;
  const preserve = new Set();
  const wps = new Set();
  for (const { id, pkg, scene } of wallpapers) {
    const kids = new Set();
    for (const o of scene.objects || []) {
      if (o.parent !== undefined && o.parent !== null) kids.add(o.parent);
    }
    for (const o of scene.objects || []) {
      if (!(o.config && o.config.passthrough === true)) continue;
      nPass++;
      wps.add(id);
      const isCtr = typeof o.image === "string" && o.image.indexOf("models/util/composelayer") === 0;
      if (isCtr) nCtr++;
      const eff = (o.effects || []).filter((e) => e.visible !== false);
      if (isCtr && !kids.has(o.id) && eff.length > 0) nEmptyEff++;
      // 几何：带旋转/负缩放的占多数 ⇒ 不能用轴对齐矩形回读，必须逐角投影
      const ang = String(o.angles || "0 0 0").trim().split(/\s+/).map(Number);
      if (Math.abs(ang[2] || 0) > 1e-6) nRot++;
      const sc = String(o.scale || "1 1 1").trim().split(/\s+/).map(Number);
      if ((sc[0] || 1) < 0 || (sc[1] || 1) < 0) nNegScale++;
      // combos 挂在**对象的 effects[].passes[]** 上，不在 effect.json 里
      for (const e of eff) {
        for (const mp of e.passes || []) {
          const c = mp.combos || {};
          if (Object.prototype.hasOwnProperty.call(c, "TRANSPARENCY") && Number(c.TRANSPARENCY) === 0) {
            preserve.add(id);
          }
        }
      }
    }
  }
  console.log(`【E. passthrough】${nPass} 处 / ${wps.size} 个壁纸，其中容器 ${nCtr}、空容器+效果 ${nEmptyEff}`);
  console.log(`   几何：z 旋转 ${nRot}、负缩放 ${nNegScale}（故必须逐角投影而非轴对齐回读）`);
  console.log(`   TRANSPARENCY=PRESERVE（连 alpha 都不含形状，最致命）：${[...preserve].sort().join(", ")}`);
  check(nPass >= 100, `passthrough 样本异常偏低: ${nPass}（预期 ≥100）`);
  check(nCtr === nPass, `passthrough 应全部是容器，实际 ${nCtr}/${nPass}`);
  check(nEmptyEff >= 110, `「空容器 + 效果」样本异常偏低: ${nEmptyEff}（预期 ≥110）`);
  check(nRot >= 50 && nNegScale >= 50,
    `带旋转/负缩放的 passthrough 层过少（${nRot}/${nNegScale}）—— 逐角投影的必要性依据没了`);
  for (const id of ["3789131791", "3789630124", "3790302364"]) {
    check(preserve.has(id), `样本 ${id} 应含 TRANSPARENCY=PRESERVE 的 passthrough 效果`);
  }

  // 解析端
  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  check(/passthrough:\s*!!\(o\.config/.test(psrc), "parse.js 未产出 passthrough 字段");

  // 渲染端接线
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  check(/function drawBackdropToFBO/.test(rsrc),
    "renderer.js 未实现 drawBackdropToFBO（passthrough 层仍拿到空画布）");
  check(/usePassthrough/.test(rsrc), "renderLayer 未按 passthrough 分流 copy pass");

  const cStart = rsrc.indexOf("function captureBackdrop");
  const cCode = rsrc.slice(cStart, cStart + 900).replace(/\/\/[^\n]*/g, "");
  // 画布是 alpha:false，默认帧缓冲没有 alpha 通道；copyTexImage2D 要求目标
  // 每个分量在源里都存在，拿 RGBA8 去拷会 INVALID_OPERATION(1282) 且**静默留下全零纹理**
  check(/copyTexImage2D\([^)]*gl\.RGB8/.test(cCode),
    "captureBackdrop 必须用 RGB8 拷贝（RGBA8 在 alpha:false 画布上会静默得到全黑纹理）");
  check(!/RGBA8/.test(cCode), "captureBackdrop 不得出现 RGBA8");

  const bStart = rsrc.indexOf("function drawBackdropToFBO");
  const bCode = rsrc.slice(bStart, bStart + 2200).replace(/\/\/[^\n]*/g, "");
  // 逐角投影：四角各自算画布 UV，由 GPU 插值 ⇒ 旋转/镜像自动成立
  check(/mat4TransformPoint/.test(bCode),
    "drawBackdropToFBO 必须逐角投影（轴对齐回读会丢掉旋转与镜像）");
  // 层 FBO 内容是倒置的（layerQuadVerts）：ortho top=fboH ⇒ 行 y=fboH 即 v=1，
  // 而合成时 LOCAL_QUAD 让屏幕下方采 v=1 ⇒ FBO 顶行必须装**屏幕下方**两角。
  // 装反了整块背景上下翻转（实测 2134765860 的 amp 区显示成错位副本）。
  check(/0,\s*fboH,\s*0,\s*sbl\[0\],\s*sbl\[1\]/.test(bCode) &&
        /fboW,\s*fboH,\s*0,\s*sbr\[0\],\s*sbr\[1\]/.test(bCode),
    "drawBackdropToFBO 的 FBO 顶行必须采样屏幕下方两角（层 FBO 倒置，装反会上下翻转）");
  // BACKDROP_FRAG 必须强制 alpha=1：画布无 alpha 通道，拷进来的 alpha 读作 0，
  // 着色器会走 scene.a=0 的错误分支（实测 2134765860 的光环整个消失）
  // （engineering/modularization：GLSL 常量本体在 renderer-glsl.js，接线检查仍看 renderer.js）
  const glslSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
  check(/BACKDROP_FRAG/.test(glslSrc), "缺少 BACKDROP_FRAG（拷回的 alpha=0 会让 scene.a 分支走错）");
  const fIdx = glslSrc.indexOf("const BACKDROP_FRAG");
  check(/fragColor\s*=\s*vec4\(texture\(u_Tex,\s*v_UV\)\.rgb,\s*1\.0\)/.test(glslSrc.slice(fIdx, fIdx + 400)),
    "BACKDROP_FRAG 必须把 alpha 强制为 1.0");
  // passthrough 层不能再走空容器那套 alpha 猜测 / 预乘合成
  check(/!layer\.groupTex\s*&&\s*!usePassthrough/.test(rsrc),
    "passthrough 层必须绕开空容器的 alpha 判定与预乘合成");
}

// ---------- F. composelayer 不是 solidlayer ----------
//
// `models/util/composelayer` 是**效果画布**，层内容本该是空白（全 0），
// 让效果链自己往上画；`models/util/solidlayer` 才是纯色层。
// 而渲染器里 solid 意味着「层内容 = whiteTex（不透明纯白）」。
// parse.js 原先把所有 `models/util/*` 一律当 solid，于是编辑器给 composelayer
// 留下的 `solid: true` 残留会让整块画布变纯白：
//   2872267921「音频」的 test_shader 写 ApplyBlending(31, albedo.rgb, color, 1.0)
//   = albedo + color，albedo 纯白 ⇒ 输出恒为 1；alpha 直通 albedo.a = 1
//   ⇒ 2000×2000 的不透明白块盖住整个画面。
{
  let ctrTotal = 0, ctrSolid = 0, ctrSolidEff = 0;
  let solidLayerSolid = 0;
  const wps = new Set();
  for (const { id, scene } of wallpapers) {
    const kids = new Set();
    for (const o of scene.objects || []) {
      if (o.parent !== undefined && o.parent !== null) kids.add(o.parent);
    }
    for (const o of scene.objects || []) {
      if (typeof o.image !== "string") continue;
      if (o.image.indexOf("models/util/solidlayer") === 0 && o.solid === true) solidLayerSolid++;
      if (o.image.indexOf("models/util/composelayer") !== 0) continue;
      ctrTotal++;
      if (o.solid !== true) continue;
      ctrSolid++;
      const eff = (o.effects || []).filter((e) => e.visible !== false);
      if (eff.length > 0 && !kids.has(o.id)) { ctrSolidEff++; wps.add(id); }
    }
  }
  console.log(`【F. composelayer ≠ solidlayer】${ctrTotal} 个 composelayer，其中带 solid 残留 ${ctrSolid} 个`);
  console.log(`   其中「空容器 + 效果」（会被喂纯白底而糊掉）：${ctrSolidEff} 个 / ${wps.size} 个壁纸`);
  console.log(`   对照：真正的 solidlayer 带 solid 的有 ${solidLayerSolid} 个（这些必须保持 solid）`);
  check(ctrSolid >= 10, `带 solid 残留的 composelayer 样本异常偏低: ${ctrSolid}（预期 ≥10）`);
  check(ctrSolidEff >= 10, `「solid composelayer + 效果」样本异常偏低: ${ctrSolidEff}（预期 ≥10）`);
  check(solidLayerSolid >= 20, `真 solidlayer 样本异常偏低: ${solidLayerSolid}（对照组失效）`);

  // 端到端：这些容器解析后必须 solid=false，而 solidlayer 必须仍是 solid=true
  const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");
  const target = wallpapers.find((w) => w.id === "2872267921");
  if (target) {
    const parsed = parseScene(target.scene, readJson(target.pkg, "project.json"));
    for (const lid of [39, 109]) {
      const L = parsed.layers.find((l) => l.id === lid);
      check(!!L, `2872267921 缺少图层 ${lid}`);
      if (L) {
        check(L.isContainer, `2872267921 图层 ${lid} 应是容器`);
        check(!L.solid, `2872267921「${L.name}」是效果画布，不能解析成 solid（会被喂纯白底、糊住整屏）`);
      }
    }
    const bg = parsed.layers.find((l) => l.id === 19);
    check(!!bg && bg.solid, "2872267921「背景」是真 solidlayer，必须保持 solid=true");
    console.log(`   样本 2872267921：39/109 容器 solid=false，19 背景 solid=${bg && bg.solid}`);
  } else {
    errors.push("壁纸库缺少样本 2872267921");
  }

  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8")
    .replace(/\/\/[^\n]*/g, "");
  check(/models\/util\/composelayer/.test(psrc),
    "solid 判定必须显式排除 composelayer（否则效果画布被喂纯白底）");
  // image=solidlayer 本身就是纯色层，不能再要求 o.solid 旗标。
  // 旧写法 `!!o.solid && … models/util/` 会让 2983846453「底部」走 transparentTex。
  check(/models\/util\/solidlayer/.test(psrc),
    "solid 判定必须认 image=solidlayer（不能只看 o.solid 旗标）");

  let parsedSolidlayer = 0, parsedSolidOk = 0;
  for (const { scene } of wallpapers) {
    const parsed = parseScene(scene, {});
    for (const L of parsed.layers) {
      if (typeof L.image !== "string" || L.image.indexOf("models/util/solidlayer") !== 0) continue;
      parsedSolidlayer++;
      if (L.solid) parsedSolidOk++;
    }
  }
  check(parsedSolidlayer >= 40, `solidlayer 样本异常偏低: ${parsedSolidlayer}`);
  check(parsedSolidOk === parsedSolidlayer,
    `所有 solidlayer 解析后必须 solid=true（缺旗标也会被当成透明层），${parsedSolidOk}/${parsedSolidlayer}`);

  const daynight = wallpapers.find((w) => w.id === "2983846453");
  if (daynight) {
    const parsed = parseScene(daynight.scene, readJson(daynight.pkg, "project.json"));
    const day = parsed.layers.find((l) => l.name === "底部");
    const night = parsed.layers.find((l) => l.name === "底部黑");
    check(!!day && day.solid, "2983846453「底部」是 solidlayer，缺 solid 旗标也必须解析成 solid（否则白天蓝底变黑）");
    check(!!night && night.solid, "2983846453「底部黑」必须是 solid");
    check(!!day && day.color[0] > 0.2 && day.color[1] > 0.5 && day.color[2] > 0.7,
      `2983846453「底部」默认应是白天蓝，实得 ${day && day.color}`);
    check(!!day && day.alpha === 1 && day.visible === true,
      `2983846453「底部」默认可见 alpha=1，实得 vis=${day && day.visible} a=${day && day.alpha}`);
    console.log(`   样本 2983846453：底部 solid=${day && day.solid} 色=${day && day.color.map((n) => n.toFixed(2))}`);
  } else {
    console.log("   skip 2983846453：库中没有这张壁纸");
  }

  // 编辑器实例化的纯色层：模型 JSON 有 solidlayer:true，image 不是 util/solidlayer。
  // parseScene 看不见模型，装配时必须 applySolidFromModel，否则 3444535389
  // 全屏黑底走 transparentTex，只剩 clearcolor 0.7 灰。
  const { applySolidFromModel } = await imp("renderer/vendor/we-scene/scene/parse.js");
  const probe = { solid: false, isContainer: false };
  applySolidFromModel(probe, { solidlayer: true });
  check(probe.solid === true, "applySolidFromModel 未把 model.solidlayer=true 写成 layer.solid");
  const probeSkip = { solid: false, isContainer: true };
  applySolidFromModel(probeSkip, { solidlayer: true });
  check(probeSkip.solid === false, "applySolidFromModel 不得把 composelayer 写成 solid");
  applySolidFromModel(probe, { solidlayer: false });
  check(probe.solid === true, "applySolidFromModel 不得在 solidlayer≠true 时清掉已有 solid");
  const msrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/applySolidFromModel\s*\(\s*layer\s*,\s*model\s*\)/.test(msrc),
    "scene-mount 加载模型后必须调用 applySolidFromModel（parseScene 看不到实例模型）");
  check(/BUILTIN_MATERIALS\s*\[\s*["']materials\/util\/solidlayer\.json["']\s*\]/.test(msrc),
    "实例 solid 缺材质时必须回退内置 solidlayer material（不能 continue 跳过效果链）");

  // 实例的用户纹理绑定（instance.usertextures）：封面组件把槽 0 绑到 $mediaThumbnail，
  // 缺绑定时 solid 白底直接画出白方块（3789462324 左下角）。绑定生效必须清 solid——
  // 渲染端 `!layer.solid && textureName` 才取纹理，solid 恒赢；且异步默认槽回写不得覆盖。
  check(/textureName\s*=\s*instBoundTex;[\s\S]{0,80}solid\s*=\s*false;/.test(msrc),
    "scene-mount 必须把槽 0 的 instance.usertextures 绑到 layer.textureName 并清 solid（否则封面白块）");
  check(/si === 0 && !instBoundTex/.test(msrc),
    "实例绑定占用槽 0 时，材质默认槽的异步回写不得覆盖 textureName");
  let utLayers = 0;
  const utWp = new Set();
  for (const { id, scene } of wallpapers) {
    for (const o of scene.objects || []) {
      const u0 = o.instance && o.instance.usertextures && o.instance.usertextures[0];
      if (u0 && typeof u0.name === "string" && u0.name.startsWith("$")) {
        utLayers++;
        utWp.add(id);
      }
    }
  }
  console.log(`   实例用户纹理绑定：${utLayers} 层 / ${utWp.size} 张（$mediaThumbnail 封面类）`);

  let instLayers = 0, instVis = 0, instWp = new Set();
  for (const { id, pkg, scene } of wallpapers) {
    for (const o of scene.objects || []) {
      const img = typeof o.image === "string" ? o.image : "";
      if (!img) continue;
      const mj = readJson(pkg, img);
      if (!mj || mj.solidlayer !== true) continue;
      instLayers++;
      instWp.add(id);
      const vis = o.visible === false ? false
        : (o.visible && typeof o.visible === "object" ? o.visible.value !== false : true);
      if (vis) instVis++;
    }
  }
  check(instLayers >= 40, `solid_instance 样本异常偏低: ${instLayers}（预期 ≥40）`);
  check(instWp.size >= 10, `带实例纯色层的壁纸过少: ${instWp.size}`);
  console.log(`   实例 solidlayer 模型：${instLayers} 层 / ${instWp.size} 张（可见 ${instVis}）`);

  const cat = wallpapers.find((w) => w.id === "3444535389");
  if (cat) {
    const parsed = parseScene(cat.scene, readJson(cat.pkg, "project.json"));
    const bg = parsed.layers.find((l) => l.id === 57);
    check(!!bg, "3444535389 应有 id=57 纯色占位符（全屏背景）");
    if (bg) {
      const mj = readJson(cat.pkg, bg.image);
      check(!!mj && mj.solidlayer === true,
        "3444535389 id=57 的模型必须带 solidlayer:true（否则装配无从置 solid）");
      check(bg.visible === true, "3444535389 id=57 默认可见");
      check(bg.color[0] === 0 && bg.color[1] === 0 && bg.color[2] === 0,
        `3444535389 id=57 默认 bgcolor 应是黑，实得 ${bg.color}`);
      const w = Math.abs(bg.size[0] * (bg.scale[0] || 1));
      const h = Math.abs(bg.size[1] * (bg.scale[1] || 1));
      check(w > 3000 && h > 2000,
        `3444535389 id=57 应铺满 3840×2160，实得 ${w.toFixed(0)}×${h.toFixed(0)}`);
      applySolidFromModel(bg, mj);
      check(bg.solid === true, "3444535389 id=57 经 applySolidFromModel 后必须 solid（否则灰底）");
    }
    const cc = String((cat.scene.general || {}).clearcolor || "");
    check(/0\.7/.test(cc), `3444535389 clearcolor 应是 0.7 灰（背景丢了才露出来），实得 ${cc}`);
  } else {
    console.log("   skip 3444535389：库中没有这张壁纸");
  }

  // general.clearcolor 绑 schemecolor 时仍是 {user,value} 包装；parseVec3Local 必须解 .value，
  // 否则 String(object)→NaN→清成黑，橘色底丢了（3792579196 / 3790389413）。
  {
    const { parseVec3Local } = await imp("renderer/vendor/we-scene/render/gl-util.js");
    const orange = parseVec3Local({ user: "schemecolor", value: "0.85882 0.67843 0.41176" });
    check(Math.abs(orange[0] - 0.85882) < 1e-4 && Math.abs(orange[1] - 0.67843) < 1e-4,
      `parseVec3Local 必须解 {user,value} 包装，实得 ${orange}`);
    check(parseVec3Local("0.1 0.2 0.3")[1] === 0.2, "parseVec3Local 字符串路径回归");
    const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/gl-util.js"), "utf8");
    check(/typeof s === ['"]object['"]/.test(src) && /\.value/.test(src),
      "gl-util parseVec3Local 源码必须对 object 取 .value");
    let wrappedCc = 0;
    for (const { id, scene } of wallpapers) {
      const cc = scene.general?.clearcolor;
      if (cc && typeof cc === "object" && cc.user) wrappedCc++;
    }
    check(wrappedCc >= 1, `库中应有 clearcolor 用户属性包装样本，实得 ${wrappedCc}`);
    console.log(`   clearcolor 包装 ${wrappedCc} 张；parseVec3Local 橘色=${orange.map((n) => n.toFixed(3))}`);
  }
}

// ---------- G. MDL 顶点布局 + 动画位移不被视锥裁掉 ----------
{
  console.log("\n[G] MDL 顶点布局 / 动画位移与视锥裁剪");

  // G1. 全库 MDL 逐个解析：版本分布、0013 自洽性、animBound 覆盖率
  const byVer = new Map();
  let v13ok = 0;
  let withAnimBound = 0;
  const v13bad = [];
  for (const w of wallpapers) {
    for (const { name } of w.pkg.entries) {
      if (!name.endsWith(".mdl")) continue;
      let m;
      try { m = parseMDL(getEntry(w.pkg, name)); }
      catch (e) {
        const raw = getEntry(w.pkg, name);
        const magic = raw ? dec.decode(raw.subarray(0, 8)) : "?";
        if (magic === "MDLV0013") v13bad.push(`${w.id} ${name}: ${e.message}`);
        continue;
      }
      byVer.set(m.magic, (byVer.get(m.magic) || 0) + 1);
      if (m.animBound) withAnimBound++;
      if (m.magic !== "MDLV0013") continue;
      // 两条自洽校验（与 mdl.js 注释记录的判定一致）
      let badW = 0;
      for (let v = 0; v < m.vertexCount; v++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += m.weights[v * 4 + k];
        if (Math.abs(s - 1) > 1e-3) badW++;
      }
      let badUV = 0;
      // 容差放到 0.01：作者的 UV 会有微量溢出（2468489223 的鱼有两个 -0.0022），
      // 那是建模精度而非解析错位 —— 布局错位会让 UV 变成成千上万的乱数，
      // 1e-3 的严格阈值只会把正常模型误判成坏的。
      for (const u of m.uvs) if (u < -0.01 || u > 1.01) badUV++;
      if (badW === 0 && badUV === 0 && m.vertexCount > 0) v13ok++;
      else v13bad.push(`${w.id} ${name}: 权重异常 ${badW} / UV 越界 ${badUV}`);
    }
  }
  console.log("   MDL 版本分布：" + [...byVer].map(([k, v]) => `${k}×${v}`).join(" "));
  check(v13bad.length === 0, `MDLV0013 解析失败或不自洽：\n      ${v13bad.join("\n      ")}`);
  check(v13ok >= 14, `MDLV0013 自洽样本过少: ${v13ok}（应 ≥14；lenOff 必须有 4 这一档）`);
  check(withAnimBound > 100, `animBound 缺失：仅 ${withAnimBound} 个 MDL 带该字段`);
  console.log(`   MDLV0013 ${v13ok} 个全部自洽（权重和=1 / UV∈[0,1]）`);

  // G2. 2477602742 三节火车：静态判定会把它们裁掉，动画位移必须把它们救回来
  const tw = wallpapers.find((w) => w.id === "2477602742");
  if (tw) {
    const parsed = parseScene(tw.scene, readJson(tw.pkg, "project.json"));
    const projW = ((tw.scene.general || {}).orthogonalprojection || {}).width || 0;
    check(projW > 0, "2477602742 读不到场景宽度");
    // 复算 isLayerOffscreen 的水平判据，余量取**渲染器真实导出的那一份**
    // （不是在测试里另写一遍，否则改坏渲染器测不出来）
    const culledX = (L, useFix) => {
      const halfW = Math.abs(L.size[0] * L.scale[0]) / 2;
      const margin = 64 + (useFix ? puppetAnimMargin(L)[0] : 0);
      return (L.origin[0] + halfW + margin < 0) || (L.origin[0] - halfW - margin > projW);
    };
    let staticCulled = 0;
    for (const nm of ["Train1", "Train2", "Train3"]) {
      const L = parsed.layers.find((l) => l.name === nm);
      check(!!L, `2477602742 缺少图层 ${nm}`);
      if (!L) continue;
      let m = null;
      try { m = parseMDL(getEntry(tw.pkg, `models/${nm}_puppet.mdl`)); }
      catch (e) {
        errors.push(`${nm} 的 MDL 解析失败（整层不渲染，火车没有网格）：${e.message}`);
        continue;
      }
      check(m.vertexCount > 0, `${nm} 网格为空（MDLV0013 没解析出来 → 整层不渲染）`);
      check(!!m.animBound, `${nm} 缺少 animBound`);
      if (!m.animBound) continue;
      // layer.puppet 是宿主（main.ts）在装载 MDL 后挂上去的，parseScene 不产出它
      L.puppet = m;
      const before = culledX(L, false);
      const after = culledX(L, true);
      if (before) staticCulled++;
      // 关键断言：算进动画位移后必须不再被裁
      check(!after, `${nm} 计入 animBound 后仍被裁（火车永远开不进画面）`);
      // 余量必须真的来自 animBound，且分轴
      const ext = puppetAnimMargin(L);
      check(ext[0] > 10000, `${nm} puppetAnimMargin X 余量为 ${ext[0].toFixed(0)}，应 >10000`);
      check(ext[1] > 1000 && ext[1] < ext[0],
        `${nm} puppetAnimMargin Y 余量应独立于 X（实际 x=${ext[0].toFixed(0)} y=${ext[1].toFixed(0)}）`);
      check(m.animBound.x > L.origin[0],
        `${nm} 动画位移 ${m.animBound.x.toFixed(0)} 应大于 origin.x ${L.origin[0].toFixed(0)}`);
      console.log(`   ${nm}: 顶点 ${m.vertexCount}，origin.x=${L.origin[0].toFixed(0)}，` +
        `余量 x=${ext[0].toFixed(0)} y=${ext[1].toFixed(0)}，静态裁剪=${before ? "裁掉" : "保留"} → 修复后=保留`);
    }
    // Train2/Train3 的 origin 远在屏外，静态判定必然裁掉 —— 这正是本用例的前提
    check(staticCulled >= 2,
      `应至少有 2 节火车在静态判定下被裁（实际 ${staticCulled}），否则这个用例护不住回归`);
  } else {
    errors.push("壁纸库缺少样本 2477602742");
  }

  // G3. 3797270925：新版 MDLV0023 84B puppet 顶点（骨骼槽前多 4B，后续属性整体后移）。
  // 旧解析只认 80B，整个人物网格加载失败；若把预留位误当骨骼/权重，蒙皮会撕开。
  const acheron = wallpapers.find((w) => w.id === "3797270925");
  if (acheron) {
    const obj = (acheron.scene.objects || []).find((o) => o.name === "acheronbody");
    check(!!obj, "3797270925 缺少 acheronbody puppet 图层");
    if (obj) {
      const model = readJson(acheron.pkg, obj.image);
      let m = null;
      try { m = parseMDL(getEntry(acheron.pkg, model.puppet)); }
      catch (e) { errors.push(`3797270925 新版 84B MDL 解析失败（人物模型无法加载）：${e.message}`); }
      if (m) {
        check(m.magic === "MDLV0023" && m.vertexCount === 3269 && m.indexCount === 16377,
          `3797270925 MDL 顶点/索引数应来自 84B 布局，实得 ${m.vertexCount}/${m.indexCount}`);
        check(m.bones.length === 123 && m.animations.length === 26,
          `3797270925 应解析 123 根骨/26 条动画，实得 ${m.bones.length}/${m.animations.length}`);
        let badWeight = 0, badUV = 0, badBone = 0, badIndex = 0;
        for (let v = 0; v < m.vertexCount; v++) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            const w = m.weights[v * 4 + k];
            const b = m.boneIdx[v * 4 + k];
            sum += w;
            if (w !== 0 && (b < 0 || b >= m.bones.length)) badBone++;
          }
          if (Math.abs(sum - 1) > 1e-4) badWeight++;
          if (m.uvs[v * 2] < -0.01 || m.uvs[v * 2] > 1.01 ||
              m.uvs[v * 2 + 1] < -0.01 || m.uvs[v * 2 + 1] > 1.01) badUV++;
        }
        for (const idx of m.indices) if (idx >= m.vertexCount) badIndex++;
        check(badWeight === 0 && badUV === 0 && badBone === 0 && badIndex === 0,
          `3797270925 84B 顶点字段不自洽：权重=${badWeight} UV=${badUV} 骨号=${badBone} 索引=${badIndex}`);
        const animIds = new Set(m.animations.map((a) => a.id));
        const matched = (obj.animationlayers || []).filter((l) => animIds.has(l.animation)).length;
        check(matched === 25, `3797270925 场景的 25 条 additive 动画层都应接到 MDLA，实接 ${matched}`);

        const P = m.positions, BI = m.boneIdx, WT = m.weights, I = m.indices;
        const skinnedAt = (t) => {
          const sk = computeSkinMatrices(m, t, obj.animationlayers);
          const out = new Float32Array(m.vertexCount * 2);
          for (let v = 0; v < m.vertexCount; v++) {
            const px = P[v * 3], py = P[v * 3 + 1];
            for (let k = 0; k < 4; k++) {
              const w = WT[v * 4 + k];
              if (w <= 0) continue;
              const mm = sk.subarray(BI[v * 4 + k] * 16, BI[v * 4 + k] * 16 + 16);
              out[v * 2] += w * (mm[0] * px + mm[4] * py + mm[12]);
              out[v * 2 + 1] += w * (mm[1] * px + mm[5] * py + mm[13]);
            }
          }
          return out;
        };
        const statsAt = (q) => {
          let flips = 0, maxD = 0;
          for (let f = 0; f + 2 < I.length; f += 3) {
            const a = I[f], b = I[f + 1], c = I[f + 2];
            const baseCross = (P[b * 3] - P[a * 3]) * (P[c * 3 + 1] - P[a * 3 + 1])
              - (P[c * 3] - P[a * 3]) * (P[b * 3 + 1] - P[a * 3 + 1]);
            const nowCross = (q[b * 2] - q[a * 2]) * (q[c * 2 + 1] - q[a * 2 + 1])
              - (q[c * 2] - q[a * 2]) * (q[b * 2 + 1] - q[a * 2 + 1]);
            if (Math.abs(baseCross) > 10 && baseCross * nowCross < 0) flips++;
          }
          for (let v = 0; v < m.vertexCount; v++) {
            maxD = Math.max(maxD, Math.hypot(q[v * 2] - P[v * 3], q[v * 2 + 1] - P[v * 3 + 1]));
          }
          return { flips, maxD };
        };
        const s0 = statsAt(skinnedAt(0));
        // 恒等阈值 0.05px：加算层 t=0 增量精确为 0（mdl-skin rest-relative），
        // 但蒙皮矩阵的 TRS 分解→composeTRS 重建每次带 ~1ulp 舍入，沿 acheron
        // 123 级骨链 × 4000px 坐标累积实测 0.024px —— 这是合成精度地板，不是
        // 动画漏进 t=0（真漏进来的话是 px 量级）。
        check(s0.maxD < 0.05 && s0.flips === 0,
          `3797270925 绑定姿势 t=0 应恒等，实得位移 ${s0.maxD.toFixed(2)}px / 翻转 ${s0.flips}`);
        let worst = { flips: s0.flips, maxD: s0.maxD };
        for (const t of [0.5, 1, 2, 5, 10, 20, 30]) {
          const s = statsAt(skinnedAt(t));
          worst = { flips: worst.flips + s.flips, maxD: Math.max(worst.maxD, s.maxD) };
        }
        check(worst.flips === 0 && worst.maxD < 100,
          `3797270925 25 层 additive 动画下模型撕开：最大位移 ${worst.maxD.toFixed(1)}px / 翻转 ${worst.flips}`);
        console.log(`   3797270925: 84B MDL 解析通过（${m.vertexCount} 顶点 / ${m.bones.length} 骨 / ${matched} 动画层），动画最大位移 ${worst.maxD.toFixed(1)}px`);
      }
    }
  } else {
    errors.push("壁纸库缺少样本 3797270925");
  }

  // G3b. additive 动画层的增量参考必须是**本轨道首关键帧**（clip 参考姿势），不是绑定姿势。
  // 工坊把加算 clip 的非目标骨烘成录制姿势的绝对局部值（≠绑定）。按绑定取增量会给
  // 全身叠恒定偏移：3148125112 人物2「眼睛」层曾把网格恒定推移 max 2337px（用户报
  // 「上半身爆开」）。rest-relative 语义下常量轨道增量恒 0，动画轨道只贡献真实运动
  //（该 clip 实测整周期 ≤31px）。直接调渲染器导出的 computeSkinMatrices（不在测试里
  // 复算公式——把渲染器改坏了测不出来）。
  {
    const rin = wallpapers.find((w) => w.id === "3148125112");
    if (rin) {
      const obj = (rin.scene.objects || []).find((o) => o.name === "人物2");
      const mjs = obj && readJson(rin.pkg, obj.image);
      check(!!(obj && mjs && mjs.puppet), "3148125112 缺少 人物2 puppet 图层");
      if (obj && mjs && mjs.puppet) {
        let m;
        try {
          m = parseMDL(getEntry(rin.pkg, mjs.puppet));
        } catch (e) {
          m = null;
          errors.push(`3148125112 人物2 MDL 解析失败：${e.message}`);
        }
        if (m) {
          const all = (obj.animationlayers || []).filter((a) => a.visible !== false);
          const bodyOnly = all.filter((a) => !a.additive);
          check(all.some((a) => a.additive), "3148125112 人物2 应有 additive 动画层（本判据的前提）");
          const P = m.positions, I = m.indices, BI = m.boneIdx, WT = m.weights;
          const skinAt = (t, layers) => computeSkinMatrices(m, t, layers);
          let worstD = 0;
          for (const t of [0, 0.5, 1, 2, 4.6, 8, 20, 300]) {
            const withAdd = skinAt(t, all);
            const mdl2 = parseMDL(getEntry(rin.pkg, mjs.puppet)); // 独立解析，避开 _skin 缓存互踩
            const noAdd = computeSkinMatrices(mdl2, t, bodyOnly);
            for (let v = 0; v < m.vertexCount; v++) {
              const at = (sk) => {
                let x = 0, y = 0;
                for (let k = 0; k < 4; k++) {
                  const w = WT[v * 4 + k];
                  if (w <= 0) continue;
                  const mm = sk.subarray(BI[v * 4 + k] * 16, BI[v * 4 + k] * 16 + 16);
                  x += w * (mm[0] * P[v * 3] + mm[4] * P[v * 3 + 1] + mm[12]);
                  y += w * (mm[1] * P[v * 3] + mm[5] * P[v * 3 + 1] + mm[13]);
                }
                return [x, y];
              };
              const a = at(withAdd), b = at(noAdd);
              worstD = Math.max(worstD, Math.hypot(a[0] - b[0], a[1] - b[1]));
            }
          }
          check(worstD < 40,
            `3148125112 人物2 additive 层贡献位移 ${worstD.toFixed(1)}px（应 <40px；按绑定姿势取增量时会到 ~2337px，上半身爆开）`);
          console.log(`   3148125112: additive「眼睛」层贡献位移 max ${worstD.toFixed(1)}px（rest-relative 语义）`);
        }
      }
    }
  }

  // G3c. additive 权重归一化只能作用于**加算增量之和**，不能把非加算层的替换姿势
  // 拉向绑定姿势。kkkk(3223543799) 可见层 = 734(blend=1 替换) + 1320/357 两条
  // additive（addW=2）：旧写法 `acc = base + (acc−base)/addW` 把 734 的装配姿势
  // 拉回图集散开位的一半（骨31 局部T −32 → −1775），人物撕成碎块；rigid 平移
  // 不产生法向翻转，I4 对此失明 —— 必须用「局部矩阵位移」判据。
  {
    const rin = wallpapers.find((w) => w.id === "3223543799");
    // 注意：本张有两个同名 kkkk 层——隐藏重复层（动画 476，屏外）与可见层
    // （动画 357）。必须用 parseScene 的**有效可见性**选层；raw objects 的
    // visible 字段形态不一，find 会命中隐藏层（G3c 第一版就踩了）。
    const L = rin ? parseScene(rin.scene).layers.find((l) => l.name === "kkkk" && l.visible === true) : null;
    const mjs = L && L.image && readJson(rin.pkg, L.image);
    check(!!(L && mjs && mjs.puppet), "3223543799 缺少可见 kkkk puppet 图层");
    if (L && mjs && mjs.puppet) {
      let m;
      try {
        m = parseMDL(getEntry(rin.pkg, mjs.puppet));
      } catch (e) {
        m = null;
        errors.push(`3223543799 kkkk MDL 解析失败：${e.message}`);
      }
      if (m) {
        const all = (L.animationLayers || []).filter((a) => a.visible !== false);
        const no357 = all.filter((a) => a.animation !== 357);
        check(all.length >= 3 && all.filter((a) => a.additive).length >= 2,
          "3223543799 kkkk 应有 替换层+2条additive（本判据的前提：addW>1）");
          let worstD = 0;
          for (const t of [0, 2, 5, 10, 15, 20, 25, 30, 40]) {
            const withAdd = computeSkinMatrices(m, t, all);
            const mdl2 = parseMDL(getEntry(rin.pkg, mjs.puppet));
            const base = computeSkinMatrices(mdl2, t, no357);
            for (let i = 0; i < m.bones.length; i++) {
              const d = Math.hypot(
                m._local[i][12] - mdl2._local[i][12],
                m._local[i][13] - mdl2._local[i][13],
              );
              void withAdd;
              if (d > worstD) worstD = d;
            }
          }
          check(worstD < 60,
            `3223543799 kkkk additive 归一化把替换姿势拉向绑定：骨局部位移 max ${worstD.toFixed(1)}px（应 <60px；旧写法实测 1777px，人物撕碎）`);
          console.log(`   3223543799: additive 归一化贡献（357 层实际增量）max ${worstD.toFixed(1)}px`);
      }
    }
  }

  // G3d. **全加算层栈的基准姿势**：一个 puppet 的动画层全是 additive（无替换层）
  // 时，第一条加算 clip 的首帧 = 该骨的装配基准（可能 ≠ 绑定）。katanabody
  // (3238423642) 10 条加算、骨 6/16/22 绑定平移 1479/2841/3075px 是图集散开位，
  // clip 值 = 装配位 ± 小幅运动：不换基准人物缺头少臂。
  {
    const rin = wallpapers.find((w) => w.id === "3238423642");
    const L = rin ? parseScene(rin.scene).layers.find((l) => l.name === "katanabody" && l.visible === true) : null;
    const mjs = L && L.image && readJson(rin.pkg, L.image);
    check(!!(L && mjs && mjs.puppet), "3238423642 缺少可见 katanabody puppet 图层");
    if (L && mjs && mjs.puppet) {
      let m;
      try {
        m = parseMDL(getEntry(rin.pkg, mjs.puppet));
      } catch (e) {
        m = null;
        errors.push(`3238423642 katanabody MDL 解析失败：${e.message}`);
      }
      if (m) {
        const all = (L.animationLayers || []).filter((a) => a.visible !== false);
        check(all.length >= 3 && all.every((a) => a.additive),
          "3238423642 katanabody 应为全 additive 层栈（本判据的前提）");
        const carrier = [6, 16, 22]; // 绑定平移 1479/2841/3075px 的散件载体骨
        let worst = 0;
        for (const t of [0, 5, 10, 20]) {
          computeSkinMatrices(m, t, all);
          for (const b of carrier) {
            const d = Math.hypot(m._local[b][12], m._local[b][13]);
            if (d > worst) worst = d;
          }
        }
        check(worst < 400,
          `3238423642 katanabody 散件载体骨局部位移 max ${worst.toFixed(0)}px（应 <400px=装配位量级；掉回绑定则是 1479~3075px，头身分离）`);
        console.log(`   3238423642: 全加算基准换位后载体骨局部T max ${worst.toFixed(0)}px（绑定值 1479~3075px）`);
      }
    }
  }

  // G4. 接线：isLayerOffscreen 必须真的用上 puppetAnimMargin（G2 直接调的是导出函数，
  // 这里补一刀确保它确实接进了裁剪判据，而不是只导出没人用）
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  const at = rsrc.indexOf("function isLayerOffscreen");
  const cull = at < 0 ? "" : rsrc.slice(at, at + 2600);
  check(/puppetAnimMargin\s*\(/.test(cull),
    "isLayerOffscreen 必须调用 puppetAnimMargin（否则靠动画开进画面的层被每帧裁掉）");
  check(/marginX/.test(cull) && /marginY/.test(cull),
    "裁剪余量必须分 X/Y 轴（animBound 两轴量级差很大）");
  // MDLV0013 布局与 animDisplacementBound 在 mdl-parse.js（engineering/modularization 拆分）
  const msrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js"), "utf8");
  check(/lenOff:\s*4,\s*stride:\s*52/.test(msrc),
    "MDLV0013 的 lenOff=4/stride=52 布局不能删（删掉后 14 个模型整层不渲染）");
  check(/stride:\s*48,\s*uv:\s*40/.test(msrc),
    "MDLV0023 真 3D 网格 stride=48/uv@40 不能删（3509243656 恒星/天空盒）");
  check(/stride:\s*84,\s*uv:\s*76,\s*bone:\s*44,\s*weight:\s*60/.test(msrc),
    "MDLV0023 新版 puppet stride=84/formatMarker=0x0181000e（uv@76/bone@44/weight@60）不能删（3797270925）");
  check(/function animDisplacementBound/.test(msrc), "animDisplacementBound 缺失");
}

// ---------------------------------------------------------------------------
// H. 图层混合：Screen/Multiply 必须带上 src 的不透明度；效果 FBO 名不一定有 _rt_ 前缀
//    两个缺陷都在 3789462324 上暴露（车尾灯纯白 + 云盖住人物）。
// ---------------------------------------------------------------------------
{
  console.log("\n[H] 图层混合的不透明度 / 效果 FBO 名解析");

  // H1. 数值回归：直接调渲染器导出的 CPU 参考实现，逐模式核对 WE 的 mix(dst, Blend, op)。
  //     用真值表而不是正则查源码 —— G 区块的教训：正则护不住「改坏了」。
  const weBlend = (mode, A, B) => {
    if (mode === 2) return A * B;                    // Multiply
    if (mode === 6) return Math.max(A, B);           // Lighten
    if (mode === 7) return 1 - (1 - A) * (1 - B);    // Screen
    if (mode === 9) return Math.min(A + B, 1);       // Add
    return B;                                        // Normal
  };
  let worst = 0;
  let worstAt = "";
  for (const mode of [0, 2, 7]) {
    for (const dst of [0, 0.1, 0.35, 0.8, 1]) {
      for (const src of [0, 0.2, 0.7, 1]) {
        for (const op of [0, 0.13, 0.5, 1]) {
          // WE 语义：mix(dst, Blend(dst, src), op)
          const want = dst + (weBlend(mode, dst, src) - dst) * op;
          const got = applyColorBlendCPU(mode, dst, src, op);
          const d = Math.abs(want - got);
          if (d > worst) { worst = d; worstAt = `mode=${mode} dst=${dst} src=${src} op=${op} 期望 ${want.toFixed(4)} 实得 ${got.toFixed(4)}`; }
        }
      }
    }
  }
  check(worst < 1e-9, `Screen/Multiply/Normal 的合成结果偏离 WE 语义，最大误差 ${worst.toFixed(6)}（${worstAt}）`);
  console.log(`   0/2/7 三种模式 × 80 组 (dst,src,op) 与 mix(dst,Blend,op) 逐点相等（最大误差 ${worst.toExponential(1)}）`);

  // op=0 必须精确退化成「这一层不存在」——这正是用户看到的症状的反面：
  // 云层实际 op=0.13 却按全不透明盖住人物，说明 op 根本没参与运算。
  for (const mode of [2, 7]) {
    for (const dst of [0, 0.3, 1]) {
      for (const src of [0, 0.5, 1]) {
        check(Math.abs(applyColorBlendCPU(mode, dst, src, 0) - dst) < 1e-9,
          `mode=${mode} 在 op=0 时应精确等于背景（dst=${dst} src=${src}），否则半透明层会当成不透明盖住下层`);
      }
    }
  }
  // 反向哨兵：如果 prep 档位被抹掉（退回「blendFunc 里没有 op」的旧行为），
  // Screen 在 op=0.13 时会算成 op=1 的结果 —— 确认该差异足够大，用例确实有鉴别力。
  const naiveScreen = (dst, src) => src + dst * (1 - src);
  const gap = Math.abs(naiveScreen(0.1, 0.7) - applyColorBlendCPU(7, 0.1, 0.7, 0.13));
  check(gap > 0.5, `旧行为与修复后的差异仅 ${gap.toFixed(3)}，用例鉴别力不足`);
  console.log(`   op=0 精确退化为背景；与「丢掉 op」的旧行为差异 ${gap.toFixed(3)}（云盖脸的量级）`);

  // H1b. shader 侧混合（Overlay/Tint 等 needsShaderBlend 模式）也必须吃层 alpha。
  //     3793592591 的 Katı 是一张铺满画面、colorBlendMode=11(Overlay)、alpha=0
  //     的白色 solidlayer：inputTex 是 1×1 白图，src.a=1。若 compBlend 只拿 src.a，
  //     就会按 op=1 把 Overlay(背景, 白)=白 写满全屏 —— 即整屏过曝。
  const sakura = wallpapers.find((w) => w.id === "3793592591");
  check(!!sakura, "壁纸库缺少样本 3793592591");
  if (sakura) {
    const solid = parseScene(sakura.scene).layers.find((l) => l.id === 471);
    check(!!solid && solid.name === "Katı" && solid.colorBlendMode === 11 && solid.alpha === 0,
      `3793592591 样本结构变化：Katı 应是 alpha=0 的 Overlay solidlayer，实得 ${JSON.stringify(solid)}`);
    let psum = 0, pbright = 0, pn = 0;
    for (const dst of [0, 0.05, 0.25, 0.7, 1]) {
      const out = applyColorBlendCPU(11, dst, 1, 0);
      psum += Math.abs(out - dst); pn++;
      pbright = Math.max(pbright, out - dst);
    }
    check(psum < 1e-9 && pbright === 0,
      `Overlay solidlayer 在层 alpha=0 时必须精确不存在，最大亮度增量 ${pbright.toFixed(6)}`);
  }

  // H2. 接线：光有正确的 plan 不够，shader 与调用点都得真的用上
  // GLSL 常量已拆至 renderer-glsl.js（engineering/modularization），文本断言随常量走
  const rsrc2 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer-glsl.js"), "utf8");
  check(/u_BlendPrep/.test(rsrc2), "u_BlendPrep 缺失（Screen/Multiply 会丢掉整层不透明度）");
  for (const [name, src] of [["COPY_FRAG", rsrc2.slice(rsrc2.indexOf("const COPY_FRAG"), rsrc2.indexOf("const COMPOSITE_FRAG"))],
                             ["COMPOSITE_FRAG", rsrc2.slice(rsrc2.indexOf("const COMPOSITE_FRAG"), rsrc2.indexOf("const BACKDROP_FRAG"))]]) {
    check(/u_BlendPrep\s*==\s*1/.test(src) && /u_BlendPrep\s*==\s*2/.test(src),
      `${name} 必须实现 prep 1(乘 src.a) 与 2(向白插值) 两档`);
    check(/c\.rgb\s*\*=\s*c\.a/.test(src), `${name} 的 prep=1 必须是 rgb *= a`);
  }
  // setColorBlend / compositeLayer 是闭包内逻辑，仍在 renderer.js
  const rsrcRenderer = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  const scb = rsrcRenderer.slice(rsrcRenderer.indexOf("function setColorBlend"), rsrcRenderer.indexOf("function setColorBlend") + 900);
  check(/colorBlendPlan\s*\(/.test(scb), "setColorBlend 必须走 colorBlendPlan（保证与 CPU 参考同源）");
  check(/blendPrep\s*=\s*prep/.test(scb), "setColorBlend 必须把 prep 记下来供合成时写入 uniform");
  const cl = rsrcRenderer.slice(rsrcRenderer.indexOf("function compositeLayer"), rsrcRenderer.indexOf("function setFrameBasis"));
  check(/uniform1i\(\s*uni\.blendPrep\s*,\s*blendPrep\s*\)/.test(cl),
    "compositeLayer 必须把 blendPrep 写进 uniform，否则 shader 永远拿到 0");
  check(/u_Opacity/.test(rsrc2) && /src\.a\s*\*\s*u_Opacity/.test(rsrc2),
    "COMPOSITE_BLEND_FRAG 必须用 src.a * u_Opacity（否则 Overlay/ColorBurn 特殊混合丢掉层 alpha）");
  check(/uniform1f\(\s*compBlendUni\.opacity\s*,\s*color4\[3\]\s*\)/.test(cl),
    "compositeLayer 必须把层 alpha color4[3] 传给 shader 侧混合，否则 alpha=0 的白色 solidlayer 全屏过曝（3793592591）");

  // H2b. additive 材质 + 对象无 colorBlendMode → 基色材质混合回退（2734266359 射灯黑方块）。
  // 黑底光斑贴图（alpha 100% 不透明）按 translucent 合成 = 整块黑方块；WE 里基色材质的
  // blending 字段（additive）就是这类层的合成模式。全库该组合仅 3 层（2734266359 ×2、
  // 3789604238 ×1），其余 additive 材质的对象都带 colorBlendMode，回退不改变既有行为。
  {
    const lcbm = layerCompositeBlendMode;
    check(typeof lcbm === "function", "renderer.js 应导出 layerCompositeBlendMode");
    const T = [
      [0, 'additive', 9, '对象无 colorBlendMode + additive 材质 → 加法'],
      [undefined, 'additive', 9, '字段缺失同样按 additive 材质走'],
      [9, 'additive', 9, '对象已有 colorBlendMode=9 → 材质不再改'],
      [0, 'translucent', 0, 'translucent 材质 + 无 colorBlendMode → 默认 translucent（不变）'],
      [0, null, 0, '材质无 blending 字段 → 默认 translucent（不变）'],
      [2, 'additive', 2, '对象 colorBlendMode=2（Multiply）时对象优先'],
    ];
    for (const [cbm, mb, want, desc] of T) {
      const got = lcbm(cbm, mb);
      check(got === want, `layerCompositeBlendMode(${cbm}, ${mb}) ${desc}：期望 ${want}，实得 ${got}`);
    }
    check(/layerCompositeBlendMode\(layer\.colorBlendMode, layer\.materialBlending\)/.test(cl),
      "compositeLayer 必须经 layerCompositeBlendMode 选择混合（additive 材质回退才生效）");
    const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    check(/layer as any\)\.materialBlending = typeof pass\?\.blending/.test(mount),
      "scene-mount 挂载时必须把基色材质 blending 写到 layer.materialBlending");
  }

  // H3. 效果自定义 FBO 的名字**不一定带 _rt_ 前缀**（车尾灯纯白的根因）。
  //     _rt_ 只是 WE 内置全屏缓冲的命名约定；effect.json 的 fbos 由作者起名，
  //     工坊效果普遍用裸名。解析时若按前缀判断，就会落到贴图表 → 查不到 → 兜底白纹理，
  //     多 pass 链从中间断掉：bloom 的 apply pass 两个输入全白 ⇒ 掩码形状糊成纯白块。
  // resolveTextureName 仍在 renderer.js（engineering/modularization：GLSL 常量拆出去了，
  // 但这个函数是闭包内逻辑，没动）；rsrcRenderer 已在上方读取
  const rtFrom = rsrcRenderer.indexOf("function resolveTextureName");
  check(rtFrom >= 0, "resolveTextureName 不存在");
  // 切到函数真正的结尾（下一个同缩进的 `\n  }`），不要按固定字符数截 ——
  // 注释很长，截短了会把关键的最后两行漏在外面，测试变成永远通过。
  const rtEnd = rsrcRenderer.indexOf("\n  }", rtFrom);
  // 只看**代码行**：这段注释里同样写着 `textures.get(name)` / `effectFBOs`，
  // 直接在整段上找子串会命中注释，得出错误的先后顺序。
  const rtLines = (rtFrom < 0 ? "" : rsrcRenderer.slice(rtFrom, rtEnd < 0 ? rtFrom + 4000 : rtEnd))
    .split("\n").filter((l) => !l.trim().startsWith("//"));
  // 关键：`_rt_` 分支**内部**也有一条 effectFBOs 查找。只按子串找「最后一次出现」
  // 会把它当成裸名兜底 —— 删掉真正的兜底行，测试照样通过（实测如此）。
  // 必须按缩进区分：分支内是 6 空格，函数体顶层是 4 空格。
  const bareLookup = rtLines.some((l) => /^ {4}if \(effectFBOs\.has\(name\)\) return effectFBOs\.get\(name\)/.test(l));
  const texIdx = rtLines.findIndex((l) => /^ {4}return textures\.get\(name\)/.test(l));
  const bareIdx = rtLines.findIndex((l) => /^ {4}if \(effectFBOs\.has\(name\)\)/.test(l));
  check(bareLookup && texIdx >= 0 && bareIdx < texIdx,
    "resolveTextureName 必须在 _rt_ 前缀分支之外（函数体顶层）、且在查贴图表**之前**再查一次 effectFBOs" +
    "（裸名 FBO 如 blur_start_2 / _downscaled1 / render_target 否则会兜底成白纹理）");

  // 全库确认这条路径真的有壁纸在走，避免用例失去意义
  let bare = 0;
  const hit = new Set();
  for (const { id, pkg } of wallpapers) {
    for (const e of pkg.entries) {
      if (!e.name || !/effects\/.*\/effect\.json$/.test(e.name)) continue;
      const j = readJson(pkg, e.name);
      if (!j) continue;
      for (const f of j.fbos || []) {
        if (f && f.name && !f.name.startsWith("_rt_")) { bare++; hit.add(id); }
      }
    }
  }
  check(hit.size >= 3, `裸名效果 FBO 的壁纸只有 ${hit.size} 个，用例样本不足`);
  console.log(`   裸名效果 FBO：${bare} 个 / ${hit.size} 个壁纸（${[...hit].slice(0, 8).join(", ")}）`);
}

// ---------- I. MDLA 关键帧槽位：欧拉角 + 三轴缩放，不是四元数 ----------
//
// 「模型爆炸散开」的根因。关键帧 9 个 float 的真实语义是
// [tx,ty,tz, rx,ry,rz, sx,sy,sz]，此前读成 [T, qx,qy,qz,qw, sx,sy]，
// 索引 3 之后整体错位一格。三条独立判据全部在这里回归。
{
  const { parseMDL } = await imp("renderer/vendor/we-scene/render/mdl.js");
  const slot = Array.from({ length: 9 }, () => ({ n0: 0, n1: 0, tot: 0, min: Infinity, max: -Infinity }));
  let winAngle = 0, winQuat = 0;
  let errAngle = [], errQuat = [];
  let models = 0;
  for (const { id, pkg, scene } of wallpapers) {
    for (const L of parseScene(scene).layers) {
      if (!L.image) continue;
      const me = getEntry(pkg, L.image);
      if (!me) continue;
      let mj; try { mj = JSON.parse(dec.decode(me)); } catch { continue; }
      if (!mj.puppet) continue;
      const raw = getEntry(pkg, mj.puppet);
      if (!raw) continue;
      let m; try { m = parseMDL(raw); } catch { continue; }
      models++;
      for (const a of m.animations)
        for (const tr of a.tracks) {
          if (!tr) continue;
          const k = tr.keyframes;
          for (let f = 0; f < tr.frameCount; f++)
            for (let j = 0; j < 9; j++) {
              const v = k[f * 9 + j], s = slot[j];
              s.tot++;
              if (Math.abs(v) < 1e-6) s.n0++;
              if (Math.abs(v - 1) < 1e-6) s.n1++;
              if (v < s.min) s.min = v;
              if (v > s.max) s.max = v;
            }
        }
      // 判据：拿 MDLS 绑定矩阵的真实旋转当真值，比对 frame0 的两种解释
      const base = m.animations.find((x) => x.mode !== "single") || m.animations[0];
      if (!base) continue;
      for (let i = 0; i < m.bones.length; i++) {
        const tr = base.tracks[i];
        if (!tr || tr.frameCount === 0) continue;
        const k = tr.keyframes, M = m.bones[i].matrix;
        const real = [M[0], M[1], M[4], M[5]];
        // 新解：k[5]=rz，k[6]/k[7]=sx/sy
        const c = Math.cos(k[5]), s = Math.sin(k[5]);
        const eN = Math.hypot(c * k[6] - real[0], s * k[6] - real[1], -s * k[7] - real[2], c * k[7] - real[3]);
        // 旧解：k[3..6]=四元数，k[7]/k[8]=缩放
        const nn = Math.hypot(k[3], k[4], k[5], k[6]) || 1;
        const X = k[3] / nn, Y = k[4] / nn, Z = k[5] / nn, W = k[6] / nn;
        const eO = Math.hypot(
          (1 - 2 * (Y * Y + Z * Z)) * k[7] - real[0], 2 * (X * Y + Z * W) * k[7] - real[1],
          2 * (X * Y - Z * W) * k[8] - real[2], (1 - 2 * (X * X + Z * Z)) * k[8] - real[3]);
        errAngle.push(eN); errQuat.push(eO);
        if (eN <= eO) winAngle++; else winQuat++;
      }
    }
  }
  check(models > 50, `puppet 样本过少: ${models}`);
  const pct = (arr, q) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length * q)]; };
  console.log(`\n[I] MDLA 关键帧槽位 = [T(3), 欧拉角(3), 缩放(3)]`);
  console.log(`   ${models} 个 puppet / ${errAngle.length} 根骨：欧拉角解释胜出 ${winAngle}，四元数解释胜出 ${winQuat}（多为 rz≈0 的平凡骨）`);
  console.log(`   全量 frame0 复原误差 p99：欧拉角=${pct(errAngle, 0.99).toFixed(4)} 四元数=${pct(errQuat, 0.99).toFixed(4)}`);

  // I1. 在旋转不为零的骨（|rz| > 0.2 rad）上，欧拉角解释必须全部更贴合绑定矩阵。
  //     |rz| 很小的时候两边都在零附近，浮点误差会导致随机胜负，无统计意义
  //     （实测 5 根「四元数更优」的骨 rz 全部恰为 0，差距 ≤0.125）。
  //     真正的试金石是大角度：四元数解释会把 rz 归一化后再乘 2，角度越大偏得越离谱。
  const MIN_ROT = 0.2;
  let bigAngle = 0, angleWins = 0, quatWins = 0;
  const errBigA = [], errBigQ = [];
  for (const { pkg, scene } of wallpapers) {
    for (const L of parseScene(scene).layers) {
      if (!L.image) continue;
      const me = getEntry(pkg, L.image);
      if (!me) continue;
      let mj; try { mj = JSON.parse(dec.decode(me)); } catch { continue; }
      if (!mj.puppet) continue;
      const raw = getEntry(pkg, mj.puppet);
      if (!raw) continue;
      let m; try { m = parseMDL(raw); } catch { continue; }
      const base = m.animations.find((x) => x.mode !== "single") || m.animations[0];
      if (!base) continue;
      for (let i = 0; i < m.bones.length; i++) {
        const tr = base.tracks[i];
        if (!tr || tr.frameCount === 0) continue;
        const k = tr.keyframes;
        if (Math.abs(k[5]) < MIN_ROT) continue;  // 小角度两边都接近零，没判别力
        bigAngle++;
        const M = m.bones[i].matrix;
        const real = [M[0], M[1], M[4], M[5]];
        const c = Math.cos(k[5]), s = Math.sin(k[5]);
        const eN = Math.hypot(c * k[6] - real[0], s * k[6] - real[1], -s * k[7] - real[2], c * k[7] - real[3]);
        const nn = Math.hypot(k[3], k[4], k[5], k[6]) || 1;
        const X = k[3] / nn, Y = k[4] / nn, Z = k[5] / nn, W = k[6] / nn;
        const eO = Math.hypot(
          (1 - 2 * (Y * Y + Z * Z)) * k[7] - real[0], 2 * (X * Y + Z * W) * k[7] - real[1],
          2 * (X * Y - Z * W) * k[8] - real[2], (1 - 2 * (X * X + Z * Z)) * k[8] - real[3]);
        errBigA.push(eN); errBigQ.push(eO);
        if (eN < eO - 1e-6) angleWins++;
        else if (eO < eN - 1e-6) quatWins++;
      }
    }
  }
  check(bigAngle >= 50 && angleWins > 0 && quatWins === 0,
    `大角度骨 ${bigAngle} 根，欧拉角胜 ${angleWins}、四元数胜 ${quatWins}；` +
    `按预期欧拉角解释应在所有大角度骨上都更优`);
  console.log(`   大角度骨（|rz|>${MIN_ROT}）：${bigAngle} 根，欧拉角胜 ${angleWins}，四元数胜 ${quatWins}（应为 0）`);
  console.log(`   大角度子集误差 p99：欧拉角=${pct(errBigA, 0.99).toFixed(4)} 四元数=${pct(errBigQ, 0.99).toFixed(4)}`);

  // I2. 逐槽分布自洽：rx/ry 恒 0（2D）、缩放槽大量恰为 1、rz 取值域远超 ±1
  const r0 = slot[3].n0 / slot[3].tot, r1 = slot[4].n0 / slot[4].tot;
  check(r0 > 0.95 && r1 > 0.95,
    `k[3]/k[4] 不是「2D 场景恒 0 的 rx/ry」：为 0 的占比 ${(r0 * 100).toFixed(1)}% / ${(r1 * 100).toFixed(1)}%`);
  for (const j of [6, 7, 8]) {
    const f = slot[j].n1 / slot[j].tot;
    check(f > 0.9, `k[${j}] 不像缩放槽：恰为 1 的占比只有 ${(f * 100).toFixed(1)}%`);
  }
  // rz 超出 ±1 → 它本就不可能是单位四元数的分量，这是最直接的证伪
  check(slot[5].min < -1 || slot[5].max > 1,
    `k[5] 取值域 [${slot[5].min.toFixed(3)}, ${slot[5].max.toFixed(3)}] 没超出 ±1，无法据此否定四元数解释`);
  console.log(`   k[3] rx 为0=${(r0 * 100).toFixed(1)}%  k[4] ry 为0=${(r1 * 100).toFixed(1)}%  k[5] rz 域=[${slot[5].min.toFixed(2)}, ${slot[5].max.toFixed(2)}]（超 ±1 ⇒ 非四元数分量）`);
  console.log(`   k[6] sx 为1=${(slot[6].n1 / slot[6].tot * 100).toFixed(1)}%  k[7] sy 为1=${(slot[7].n1 / slot[7].tot * 100).toFixed(1)}%  k[8] sz 为1=${(slot[8].n1 / slot[8].tot * 100).toFixed(1)}%`);

  // I3. mirror 模式必须有独立分支：否则 t 超过一个周期就冻结在末帧
  // sampleTrackTRS 已拆至 mdl-skin.js（enginering/modularization），文本断言随函数走
  const src = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl-skin.js"), "utf8");
  check(/anim\.mode === 'mirror'/.test(src),
    "sampleTrackTRS 缺少 mirror 分支，mirror 动画会被 clamp 冻结在末帧");
  const mir = new Set();
  for (const { id, pkg, scene } of wallpapers) {
    for (const L of parseScene(scene).layers) {
      if (!L.image) continue;
      const me = getEntry(pkg, L.image);
      if (!me) continue;
      let mj; try { mj = JSON.parse(dec.decode(me)); } catch { continue; }
      if (!mj.puppet) continue;
      const raw = getEntry(pkg, mj.puppet);
      if (!raw) continue;
      let m; try { m = parseMDL(raw); } catch { continue; }
      if (m.animations.some((a) => a.mode === "mirror")) mir.add(id);
    }
  }
  console.log(`   mirror 模式动画的壁纸：${mir.size} 个（${[...mir].join(", ")}）`);

  // 【I4】绑定姿势必须**单一来源**：invBindWorld 与 bindTRS 都取 MDLS 的
  // bones[i].matrix（局部，累乘父链），不能一个取 frame0 一个取 bone.matrix。
  //
  // 判据是**三角形法向翻转**（蒙皮后有向面积变号 = 真几何撕裂）。这是唯一有判别力的
  // 指标：t=0 顶点归位是恒等式（非 additive 层 blend=1 时把 base 整个替换掉），
  // 两套姿势都恒为 0；「单边拉伸比」也不行（<30px 短边在骨混合下天然放大到 10x，
  // 正常模型同样测得出）。全库翻转总数：正确 = 4xx，两套参考系混用 = 3264。
  let flipSum = 0;
  for (const { pkg, scene } of wallpapers) {
    for (const L of parseScene(scene).layers) {
      if (!L.image) continue;
      const me = getEntry(pkg, L.image);
      if (!me) continue;
      let mj; try { mj = JSON.parse(dec.decode(me)); } catch { continue; }
      if (!mj.puppet) continue;
      const raw = getEntry(pkg, mj.puppet);
      if (!raw) continue;
      let mdl; try { mdl = parseMDL(raw); } catch { continue; }
      if (!mdl.bones.length || !mdl.animations.length) continue;
      const layers = (L.animationLayers || []).filter((a) => a.visible !== false);
      if (!layers.length) continue;
      const P = mdl.positions, I = mdl.indices, BI = mdl.boneIdx, WT = mdl.weights;
      for (const t of [1, 3, 5, 8]) {
        const sk = computeSkinMatrices(mdl, t, layers);
        if (!sk) continue;
        const sp = (i) => {
          let px = 0, py = 0;
          for (let k = 0; k < 4; k++) {
            const w = WT[i * 4 + k]; if (w <= 0) continue;
            const m = sk.subarray(BI[i * 4 + k] * 16, BI[i * 4 + k] * 16 + 16);
            px += w * (m[0] * P[i * 3] + m[4] * P[i * 3 + 1] + m[12]);
            py += w * (m[1] * P[i * 3] + m[5] * P[i * 3 + 1] + m[13]);
          }
          return [px, py];
        };
        for (let f = 0; f < I.length; f += 3) {
          const a = I[f], b = I[f + 1], c = I[f + 2];
          const a0 = (P[b * 3] - P[a * 3]) * (P[c * 3 + 1] - P[a * 3 + 1])
            - (P[c * 3] - P[a * 3]) * (P[b * 3 + 1] - P[a * 3 + 1]);
          if (Math.abs(a0) < 10) continue;
          const A = sp(a), B = sp(b), C = sp(c);
          if (((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / a0 < 0) flipSum++;
        }
      }
    }
  }
  console.log(`   蒙皮三角形法向翻转总数：${flipSum}（参考：绑定姿势串了会涨到 3264）`);
  check(flipSum < 1200,
    `蒙皮出现 ${flipSum} 个三角形法向翻转 —— invBindWorld 与 bindTRS 可能用了不同的绑定姿势`);

  // I5. 图集散件必须按 frame0 拼回脸上；层全关必须回到绑定姿势（3233141951）
  check(/hadExplicitLayers/.test(src),
    "computeSkinMatrices 缺少 hadExplicitLayers：visible:false 的层会退回 animations[0]");
  const parseSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/mdl-parse.js"), "utf8");
  check(!/applyParkedBindOverrides/.test(parseSrc),
    "不要把停驻轨道吸收进 bind：3233141951 头的眼睛会停在图集边上");

  const wp323 = wallpapers.find((w) => w.id === "3233141951");
  if (wp323) {
    const scene323 = parseScene(wp323.scene);
    const skinnedAABB = (mdl, layers, t) => {
      const sk = computeSkinMatrices(mdl, t, layers);
      if (!sk) return { w: 0, h: 0, maxD: Infinity, maxX: 0 };
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxD = 0;
      const P = mdl.positions, BI = mdl.boneIdx, WT = mdl.weights;
      for (let i = 0; i < mdl.vertexCount; i++) {
        let x = 0, y = 0;
        const px = P[i * 3], py = P[i * 3 + 1];
        for (let k = 0; k < 4; k++) {
          const w = WT[i * 4 + k]; if (w <= 0) continue;
          const m = sk.subarray(BI[i * 4 + k] * 16, BI[i * 4 + k] * 16 + 16);
          x += w * (m[0] * px + m[4] * py + m[12]);
          y += w * (m[1] * px + m[5] * py + m[13]);
        }
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        const d = Math.hypot(x - px, y - py);
        if (d > maxD) maxD = d;
      }
      return { w: maxX - minX, h: maxY - minY, maxD, maxX };
    };
    const loadPuppet = (layerName) => {
      const L = scene323.layers.find((l) => l.name === layerName);
      const mj = JSON.parse(dec.decode(getEntry(wp323.pkg, L.image)));
      return { L, mdl: parseMDL(getEntry(wp323.pkg, mj.puppet)) };
    };
    const head = loadPuppet("头");
    const restW = head.mdl.bounds.maxX - head.mdl.bounds.minX;
    const head0 = skinnedAABB(head.mdl, head.L.animationLayers, 0);
    check(head0.w / restW < 0.6 && head0.w > 400,
      `3233141951 头 t=0 应把图集散件（眼睛）收拢到脸上：${head0.w.toFixed(0)} / 静止 ${restW.toFixed(0)}`);
    // 虹膜高光在 头.tex (2842,1032)，静止网格 x≈800；拼上脸后应落到脸部 x≈229
    let eyeX = 0, eyeN = 0;
    const W = head.L.size[0], H = head.L.size[1];
    const skEye = computeSkinMatrices(head.mdl, 0, head.L.animationLayers);
    for (let i = 0; i < head.mdl.vertexCount; i++) {
      const px = (head.mdl.uvs[i * 2] * W) | 0;
      const py = (head.mdl.uvs[i * 2 + 1] * H) | 0;
      if (px < 2830 || px > 2860 || py < 1020 || py > 1045) continue;
      const x0 = head.mdl.positions[i * 3], y0 = head.mdl.positions[i * 3 + 1];
      let x = 0, y = 0;
      for (let k = 0; k < 4; k++) {
        const w = head.mdl.weights[i * 4 + k]; if (w <= 0) continue;
        const m = skEye.subarray(head.mdl.boneIdx[i * 4 + k] * 16, head.mdl.boneIdx[i * 4 + k] * 16 + 16);
        x += w * (m[0] * x0 + m[4] * y0 + m[12]);
        y += w * (m[1] * x0 + m[5] * y0 + m[13]);
      }
      eyeX += x; eyeN++;
    }
    const eyeCx = eyeN ? eyeX / eyeN : 0;
    check(eyeN > 10 && eyeCx > 150 && eyeCx < 350,
      `3233141951 头眼睛应拼到脸上（x≈229），实得 n=${eyeN} x=${eyeCx.toFixed(1)}`);
    const dragon = loadPuppet("龙");
    const b1 = dragon.mdl.bindTRS[1];
    const a1 = dragon.mdl.animations.find((a) => a.id === 546);
    const f0 = a1.tracks[1].keyframes;
    check(Math.hypot(b1[0] - f0[0], b1[1] - f0[1]) > 500,
      "3233141951 龙骨1 的 bind 不该被动画1 frame0 吸收（additive 层相对 MDLS）");
    const knife = loadPuppet("刀");
    const off = knife.L.animationLayers.map((a) => ({ ...a, visible: false }));
    const knifeOff = skinnedAABB(knife.mdl, off, 15);
    check(knifeOff.maxD < 2,
      `刀动画 visible:false 时 t=15 仍位移 ${knifeOff.maxD.toFixed(1)}px（退回了 animations[0]）`);
    const knifeOn = skinnedAABB(knife.mdl, knife.L.animationLayers, 15);
    check(knifeOn.maxD > 50,
      `刀动画开启时 t=15 位移只有 ${knifeOn.maxD.toFixed(1)}px，对照开关失效`);
    const bars = scene323.layers.filter((l) => /^剑音条/.test(l.name));
    check(bars.length === 2, `3233141951 应有 2 层剑音条，实得 ${bars.length}`);
    for (const L of bars) {
      check(layerWantsPreserveBackdrop(L),
        `${L.name} TRANSPARENCY=0 应走 preserve 背景（空画布 scene.a=0 时音条不可见）`);
    }
    const rsrc323 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    check(/passthrough[\s\S]{0,80}layerWantsPreserveBackdrop\s*\(\s*layer\s*\)/.test(rsrc323),
      "usePassthrough 必须并上 layerWantsPreserveBackdrop（剑音条没打 passthrough 旗标）");

    // I5b. 面具01 是肩饰，作者 origin 就在胸口。图 3「没绑上」是空组 576 写了
    // parallax 1.4、子层没写，合并 origin 后视差变成 0，人物动、肩饰钉死。
    // 不要发明 attachment，也不要用 cropoffset 把肩饰挪到头上。
    const mask = scene323.layers.find((l) => l.name === "面具01");
    const orn1 = scene323.layers.find((l) => l.name === "挂饰1");
    const orn2 = scene323.layers.find((l) => l.name === "挂饰2");
    const headL = scene323.layers.find((l) => l.name === "头");
    const grp = scene323.layers.find((l) => l.id === 576);
    const maskObj = (wp323.scene.objects || []).find((o) => o.name === "面具01");
    check(mask && orn1 && orn2 && grp, "3233141951 应有 面具01/挂饰1/挂饰2 和空组 576");
    check(scene323.layers.every((l) => !l.attachment),
      "3233141951 没有 attachment 字段，不要发明 MDAT 绑定");
    check(maskObj && maskObj.parallaxDepth === undefined,
      "面具01 自己没写 parallaxDepth，1.4 必须来自空组继承");
    check(grp.parallaxDepth && Math.abs(grp.parallaxDepth[0] - 1.4) < 1e-6,
      "空组 576 的 parallax 应为 1.4");
    for (const L of [mask, orn1, orn2]) {
      check(L.parallaxDepth && Math.abs(L.parallaxDepth[0] - 1.4) < 1e-6,
        `${L.name} 应继承空组 576 的 parallax 1.4，实得 ${L.parallaxDepth}`);
    }
    const dMask = Math.hypot(mask.origin[0] - headL.origin[0], mask.origin[1] - headL.origin[1]);
    check(dMask > 400 && mask.origin[1] < 700,
      `面具01 是肩饰，origin 应停在胸口（距头 ${dMask.toFixed(0)}px）；不要拿 cropoffset 对齐头`);
    const parseSrc323 = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
    check(/p\.image \|\| p\.particle \|\| p\.model/.test(parseSrc323) &&
      /L\.parallaxDepth = p\.parallaxDepth\.slice\(\)/.test(parseSrc323),
      "parse.js 必须从空组继承 parallaxDepth（子层没写时）");
    check(!/cropDrawOffset/.test(rsrc323),
      "layerModelMatrix 不要再减 cropDrawOffset（肩饰会被错挪到头上）");

    // I5c. cropoffset **不是位置补偿项**。上面那条正则只防"cropDrawOffset"这一个名字，
    // 防不住有人换个写法重新发明加法（判据：正则只看形状、不看语义）。这里落数值判据。
    //
    // 假说「origin 里少加了裁切补偿」若成立，则 origin −(crop + size/2) 应当各层一致。
    // 实测它从 朱鹤(−270, 792) 一路发散到 烟1(2201, 1017)，跨度 >2400px，假说不成立。
    // 反证补强：`头` 层**没有** cropoffset，而它的贴图 w/h 恰好等于整画布 4096×2296 ——
    // crop 只出现在"从大画布裁出来的小图"上，origin 已是作者摆好的最终世界坐标。
    {
      const deltas = [];
      for (const L of scene323.layers) {
        if (!L.image) continue;
        const ent = getEntry(wp323.pkg, L.image);
        if (!ent) continue;
        const mj = JSON.parse(dec.decode(ent));
        if (!mj.cropoffset) continue;
        const c = String(mj.cropoffset).trim().split(/\s+/).map(Number);
        deltas.push(L.origin[0] - (c[0] + L.size[0] / 2));
      }
      check(deltas.length >= 10,
        `3233141951 应有 ≥10 个带 cropoffset 的层，实得 ${deltas.length}`);
      const spreadX = Math.max(...deltas) - Math.min(...deltas);
      check(spreadX > 1000,
        `origin−(crop+size/2) 必须保持发散（实得跨度 ${spreadX.toFixed(0)}px）：` +
        "这个值一旦收敛成常数，说明有人把 cropoffset 当位置补偿加进了 origin");
    }

    console.log(`   3233141951 头 t=0 宽 ${head0.w.toFixed(0)}/${restW.toFixed(0)} 眼x=${eyeCx.toFixed(0)}；刀关 ${knifeOff.maxD.toFixed(1)}px 开 ${knifeOn.maxD.toFixed(1)}px`);
  } else {
    console.log("   skip I5：库中没有 3233141951");
  }
}

// ---------- J. 跨层合成引用 `_rt_imageLayerComposite_<objectId>_a` ----------
//
// WE 的「图层作为纹理」：作者把一层设成 visible:false 当纯素材（封面、遮罩），
// 另一层在自己的效果链里采样**那一层跑完效果链后的合成结果**。
//
// 旧实现的 resolveTextureName 不看层号，一律返回**当前层自己的** inputFBO。
// 2938612768 的背景层引用的是隐藏的「默认音频封面azb」，取到自己（空容器 =
// 全透明）后整屏只剩灰底，原版那张模糊铺屏的专辑封面完全不见。
//
// 这一段守三件事：解析面（引用能对上真实对象）、接线面（渲染器真的按层查表）、
// 空 composelayer 源必须在主循环 z 序回读而不能预渲染全透明 / 回退白三角自身。
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");

  // --- 接线：必须按层号查预渲染表，不能再回退成 inputFBO ---
  check(/function renderCompositeSources/.test(rsrc),
    "renderer.js 未实现 renderCompositeSources（合成源层不会被预渲染）");
  check(/compositeFBOs/.test(rsrc),
    "缺少 compositeFBOs 合成表（resolveTextureName 无从按层号查）");
  check(/_rt_imageLayerComposite_\(\\d\+\)_\[a-z\]|_rt_imageLayerComposite_\(\\d\+\)/.test(rsrc)
    || /imageLayerComposite_\(/.test(rsrc),
    "renderCompositeSources 未按 `_rt_imageLayerComposite_<id>_x` 的层号正则收集引用");

  // 源层必须落进**独占** FBO。共享乒乓 fboA/fboB 按尺寸缓存、被所有图层复用，
  // 源层的结果会被引用方进场时的 clear 冲掉 —— README 记过这条导致整屏全白。
  // 取整个函数体：用大括号配平找结尾，别用固定长度切片 —— 函数一长（或补了注释）
  // 就会把后半段切掉，检查悄悄变成「永远查不到 ⇒ 永远报错」或「永远查不到 ⇒ 漏报」。
  const cStart = rsrc.indexOf("function renderCompositeSources");
  let cCode = "";
  if (cStart >= 0) {
    const open = rsrc.indexOf("{", cStart);
    let depth = 0;
    let end = open;
    for (let i = open; i < rsrc.length; i++) {
      const ch = rsrc[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    cCode = rsrc.slice(cStart, end);
  }
  check(cCode.length > 0, "找不到 renderCompositeSources 的函数体");
  check(/getFBO\([^)]*'lc:'/.test(cCode) || /getFBO\([^)]*`lc:/.test(cCode),
    "合成源必须用 'lc:'+id 的独占 FBO tag（复用共享乒乓会被引用方 clear 冲掉，整屏全白）");
  check(!/getFBO\([^)]*['"`](ping|pong)['"`]/.test(cCode),
    "合成源不能借用 ping/pong 共享乒乓");

  // groupTarget 是模块级单变量：必须保存/恢复，硬置 null 会破坏嵌套
  check(/savedTarget\s*=\s*groupTarget/.test(cCode) && /groupTarget\s*=\s*savedTarget/.test(cCode),
    "renderCompositeSources 必须保存/恢复 groupTarget（硬置 null 会破坏外层组渲染）");
  // 源层是 visible:false 的素材，预渲染时要临时放行并在之后恢复
  check(/savedVisible/.test(cCode) && /src\.visible\s*=\s*savedVisible/.test(cCode),
    "renderCompositeSources 必须恢复源层的 visible（否则隐藏素材层会漏进主画面）");
  check(/savedOrigin/.test(cCode) && /src\.origin\s*=\s*savedOrigin/.test(cCode),
    "renderCompositeSources 必须恢复源层的 origin");

  // 查表必须先于回退：顺序反了等于没实现
  const rStart = rsrc.indexOf("function resolveTextureName");
  const rCode = rStart >= 0 ? rsrc.slice(rStart, rStart + 1800) : "";
  const hasIdx = rCode.indexOf("compositeFBOs.has");
  const retIdx = rCode.indexOf("return inputFBO", hasIdx >= 0 ? hasIdx : 0);
  check(hasIdx >= 0, "resolveTextureName 未查 compositeFBOs");
  check(hasIdx >= 0 && retIdx > hasIdx,
    "resolveTextureName 必须**先**查合成表再回退 inputFBO（顺序反了等于没实现）");

  // --- 解析面：全库引用能对上真实对象 ---
  let refTotal = 0;
  let refWallpapers = 0;
  let refMissing = 0;
  let refSelf = 0;
  let srcWithModel = 0;
  let srcCompose = 0;
  let srcComposeHidden = 0;
  const missDetail = [];
  const hiddenDetail = [];

  let ids = [];
  try { ids = fs.readdirSync(LIB); } catch { ids = []; }
  for (const id of ids) {
    const pkgPath = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let scene;
    try {
      const e = getEntry(parsePkg(fs.readFileSync(pkgPath)), "scene.json");
      if (!e) continue;
      scene = JSON.parse(Buffer.from(e).toString("utf8"));
    } catch { continue; }
    if (!scene || !Array.isArray(scene.objects)) continue;

    // 收集「哪个对象引用了哪个对象」
    const refs = [];
    for (const o of scene.objects) {
      const walk = (n) => {
        if (typeof n === "string") {
          const m = /^_rt_imageLayerComposite_(\d+)_[a-z]$/.exec(n);
          if (m) refs.push({ from: o.id, to: Number(m[1]) });
          return;
        }
        if (Array.isArray(n)) return n.forEach(walk);
        if (n && typeof n === "object") return Object.values(n).forEach(walk);
      };
      walk(o.effects || []);
    }
    if (refs.length) refWallpapers++;
    for (const { from, to } of refs) {
      refTotal++;
      if (from === to) refSelf++;
      const src = scene.objects.find((x) => x.id === to);
      if (!src) { refMissing++; missDetail.push(`${id}#${to}`); continue; }
      const img = typeof src.image === "string" ? src.image : "";
      if (img.indexOf("models/util/composelayer") === 0) {
        srcCompose++;
        // 空 composelayer 源里**自己也是 visible:false** 的那一批：主循环的
        // visible 闸门若不放行，这些引用永远取不到图（见下方接线断言）。
        const v = src.visible;
        const vis = v === undefined || v === true ||
          (v !== null && typeof v === "object" && v.value === true);
        const emptyEff = !(src.effects || []).some((e) => e.visible !== false);
        if (!vis && emptyEff) {
          srcComposeHidden++;
          hiddenDetail.push(`${id}#${to}`);
        }
      } else if (img) srcWithModel++;
    }
  }

  if (refTotal > 0) {
    check(refMissing === 0,
      `${refMissing} 处 _rt_imageLayerComposite 引用指向不存在的对象：${missDetail.slice(0, 5).join(", ")}`);
    check(srcWithModel > 0,
      "应存在「带模型的合成源」（封面类）；若为 0 说明引用解析或库数据变了");
    // **自引用是合法形态**（全库 26 处）：层在自己的效果链里引用自己的合成结果，
    // 形态是 blur / godrays 这类「取当前链上画面再叠一层」
    // （1444077782 Fullscreen、1457581889 Compose、1937925563 可视化条）。
    // 这时正解是回退到当前 pass 的链输入，而**不能**预渲染一份跑完整条链的副本
    // 再喂回去 —— 那会把整条效果链施加两遍。实现里必须显式跳过。
    check(refSelf > 0,
      "库里应存在自引用（若为 0，说明引用扫描漏了这一形态，跳过逻辑就失去了回归覆盖）");
    check(/if\s*\(\s*selfRefIds\.has\(oid\)\s*\)\s*continue/.test(cCode),
      "renderCompositeSources 未在预渲染循环里跳过自引用");
    check(/composelayer/.test(cCode),
      "renderCompositeSources 的空画布判定未识别 models/util/composelayer");
    // 预渲染循环仍必须跳过空 composelayer（那时画布只有 clearcolor）。
    // 但跳过时要登记 pendingEmptyCompose，主循环 z 序再 drawBackdropToFBO。
    // 只留 `if (isEmptyCompose) continue` 会回退 inputFBO → 2902406982 白三角。
    check(/if\s*\(\s*isEmptyCompose\s*\)[\s\S]{0,160}pendingEmptyCompose\.set[\s\S]{0,80}continue/.test(cCode),
      "renderCompositeSources 跳过空 composelayer 时必须登记 pendingEmptyCompose（不能只 continue）");
    check(/function captureEmptyComposeAtZOrder/.test(rsrc),
      "空 composelayer 源必须在主循环 z 序回读（captureEmptyComposeAtZOrder）");
    check(/if\s*\(\s*!hasVisibleEffects\s*\)[\s\S]{0,220}captureEmptyComposeAtZOrder/.test(rsrc),
      "主循环跳过无效果空容器时必须调用 captureEmptyComposeAtZOrder");
    // **visible:false 的源也必须走得到回读钩子。** 这些层正是靠 visible:false 才不
    // 出现在画面上的纯素材（renderCompositeSources 自己的注释：「源层几乎都是
    // visible:false」）。主循环第一行的 `if (!layer.visible) continue` 抢在
    // isContainer 分支之前把它们踢掉，`_rt_imageLayerComposite_<id>_a` 就永远进不了
    // compositeFBOs，resolveTextureName 回退成引用方自己的 inputFBO，clipping_mask
    //   albedo.rgb = ApplyBlending(mode, albedo.rgb, clip.rgb, mask * albedo.a * u_alpha)
    // 白混白 = 一块矩形白板（2938612768 音条左侧白块）。
    // destroyed 墓碑不能跟着一起放行：那是层已被 destroyLayer 拆掉。
    check(/if\s*\(\s*layer\.destroyed\s*\)\s*continue/.test(rsrc),
      "主循环必须单独保留 destroyed 墓碑的 continue（与 visible 合并会把已拆层一起放行）");
    check(/if\s*\(\s*!layer\.visible\s*\)\s*\{[\s\S]{0,400}pendingEmptyCompose\.has\(layer\.id\)[\s\S]{0,200}captureEmptyComposeAtZOrder/.test(rsrc),
      "主循环 visible 闸门必须放行「待回读的空 composelayer 源」" +
      "（否则 visible:false 的遮罩源取不到，clipping_mask 白混白出白块）");
    const capStart = rsrc.indexOf("function captureEmptyComposeAtZOrder");
    let capCode = "";
    if (capStart >= 0) {
      const open = rsrc.indexOf("{", capStart);
      let depth = 0;
      let end = open;
      for (let i = open; i < rsrc.length; i++) {
        const ch = rsrc[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { end = i + 1; break; }
        }
      }
      capCode = rsrc.slice(capStart, end);
    }
    check(capCode.length > 0, "找不到 captureEmptyComposeAtZOrder 的函数体");
    check(/drawBackdropToFBO/.test(capCode),
      "空 composelayer 捕获必须走 drawBackdropToFBO（RGB8 回读），不能预渲染全透明");
    check(/compositeFBOs\.set/.test(capCode),
      "捕获结果必须写入 compositeFBOs，否则 resolveTextureName 仍回退 inputFBO（白三角）");
    check(/bindFramebuffer[\s\S]{0,80}null/.test(capCode) &&
      /viewport\(\s*0\s*,\s*0\s*,\s*width\s*,\s*height\s*\)/.test(capCode),
      "回读后必须恢复画布 FBO/viewport，否则后续层画进合成 FBO 尺寸的角落");
    console.log(
      `   跨层合成：${refTotal} 处引用 / ${refWallpapers} 张壁纸` +
      `（源层带模型 ${srcWithModel}，空 composelayer ${srcCompose}，自引用 ${refSelf}）`,
    );
    if (srcCompose > 0) {
      console.log(
        `   空 composelayer 源 ${srcCompose} 个：预渲染跳过，主循环 z 序 drawBackdropToFBO 回读`,
      );
      // 这一批（源自身 visible:false）就是上面那条 visible 闸门断言保护的对象。
      // 它若归零，说明库或扫描变了，接线断言就失去了真实覆盖 —— 要人来看一眼。
      check(srcComposeHidden > 0,
        "库里应存在 visible:false 的空 composelayer 合成源（归零则 visible 闸门放行的接线断言失去覆盖）");
      console.log(
        `   其中源自身 visible:false 的 ${srcComposeHidden} 个（必须靠 visible 闸门放行才取得到）：` +
        `${hiddenDetail.slice(0, 8).join(", ")}`,
      );
    }
    const wp290 = wallpapers.find((w) => w.id === "2902406982");
    if (wp290) {
      const mods = (wp290.scene.objects || []).filter((o) => /^三角模块/.test(o.name || ""));
      check(mods.length === 6, `2902406982 应有 6 个三角模块，实得 ${mods.length}`);
      for (const m of mods) {
        const img = typeof m.image === "string" ? m.image : "";
        check(img.indexOf("models/util/composelayer") === 0,
          `2902406982 ${m.name} 应是 composelayer`);
        const nEff = (m.effects || []).filter((e) => e.visible !== false).length;
        check(nEff === 0, `2902406982 ${m.name} 应无可见效果（空画布捕获点）`);
      }
      const clipCount = (wp290.scene.objects || []).filter((o) =>
        /clipping_mask/.test(JSON.stringify(o.effects || []))).length;
      check(clipCount >= 7, `2902406982 clipping_mask 三角层过少: ${clipCount}`);
      const t13 = (wp290.scene.objects || []).find((o) => o.name === "三角13");
      check(!!t13, "2902406982 应有「三角13」");
      if (t13) {
        check(/_rt_imageLayerComposite_125_a/.test(JSON.stringify(t13.effects || [])),
          "2902406982 三角13 应引用三角模块1（id 125）");
      }
      const m1 = mods.find((m) => m.id === 125);
      check(!!m1 && m1.name === "三角模块1", "2902406982 id 125 应是三角模块1");
    } else {
      console.log("   skip 2902406982 语料：库中没有该壁纸");
    }
  } else {
    console.log("   跨层合成：未找到壁纸库，跳过引用解析检查");
  }
}

// ---------- K. 全屏后期层（fullscreenlayer / projectlayer）不得整层跳过 ----------
// 973101892 星云「不会动」：动画在 Fullscreen 的 waterripple/pulse/godrays，
// 渲染器曾 `if (layer.isPostProcess) continue`，装配又因 pkg 无
// models/util/fullscreenlayer.json 而跳过效果解析。作者 size 还是编辑器
// 预览框 1248×702 @ origin 0，不拉成正交投影就只动左上角一块。
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  const esrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/effects-parse.js"), "utf8");
  check(!/if\s*\(\s*layer\.isPostProcess\s*\)\s*continue/.test(rsrc),
    "renderer 不得无条件跳过 isPostProcess（973101892 星云会变成静图）");
  check(/isPostProcess[\s\S]{0,120}effects[\s\S]{0,80}visible/.test(rsrc) ||
    /isPostProcess\s*&&\s*!\(layer\.effects/.test(rsrc),
    "无效果的空 fullscreenlayer 仍应跳过（避免无意义回读）");
  check(/isPostProcess/.test(rsrc) && /usePassthrough/.test(rsrc) &&
    /!!layer\.isPostProcess/.test(rsrc),
    "usePassthrough 必须并上 isPostProcess（后期层内容 = 画布回读）");
  check(/fullscreenlayer\.json/.test(esrc) && /projectlayer\.json/.test(esrc),
    "BUILTIN_MODELS 必须注册 fullscreenlayer/projectlayer（否则装配 continue，效果不解析）");
  check(/orthogonalprojection/.test(psrc) && /gw \/ 2/.test(psrc),
    "parse 必须把后期层矩形拉成正交投影（不能用编辑器预览框）");

  const id = "973101892";
  const pkgPath = join(LIB, id, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const raw = JSON.parse(dec.decode(getEntry(parsePkg(fs.readFileSync(pkgPath)), "scene.json")));
    const parsed = parseScene(raw, {});
    const fsLayer = parsed.layers.find((l) => l.isPostProcess);
    check(!!fsLayer, `${id} 必须能解析出 fullscreen 后期层`);
    const gw = raw.general.orthogonalprojection.width;
    const gh = raw.general.orthogonalprojection.height;
    check(fsLayer.size[0] === gw && fsLayer.size[1] === gh,
      `${id} 后期层 size 应为 ${gw}×${gh}，实得 ${fsLayer.size}`);
    check(Math.abs(fsLayer.origin[0] - gw / 2) < 1e-6 && Math.abs(fsLayer.origin[1] - gh / 2) < 1e-6,
      `${id} 后期层 origin 应在画面中心，实得 ${fsLayer.origin}`);
    check(fsLayer.effects.length >= 3, `${id} Fullscreen 应挂 3 个效果，实得 ${fsLayer.effects.length}`);
    const files = fsLayer.effects.map((e) => e.file).join(" ");
    check(/waterripple/.test(files) && /pulse/.test(files) && /godrays/.test(files),
      `${id} 效果应含 waterripple/pulse/godrays，实得 ${files}`);
    const bg = parsed.layers.find((l) => !l.isPostProcess && l.image);
    check(bg && !bg.isPostProcess, `${id} 底图层不得被标成后期层`);
    console.log(`   K. ${id} 后期层 ${fsLayer.size[0]}×${fsLayer.size[1]} @ ${fsLayer.origin[0]},${fsLayer.origin[1]} fx=${fsLayer.effects.length}`);
  } else {
    console.log("   skip K：库中没有 973101892");
  }
}

// ---------- L. copy 命令必须画满整块 FBO（1444077782 白三角）----------
// motionblur 的 copy pass 把本帧累积结果存进 unique 历史缓冲。PASS_QUAD 是
// 6 顶点 TRIANGLES 列表；画 TRIANGLE_STRIP 4 个顶点时第 4 个是重复的 TR，
// 第二条退化，历史只写入一块对角三角。全库 7 张带 copy 的壁纸都会半块拷贝，
// 1444077782 两条 fullscreen motionblur 叠上去就是左侧硬边白三角。
{
  const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
  const copyBlock = rsrc.split("if (mp.copyCommand)").slice(1)[0] || "";
  const body = copyBlock.slice(0, copyBlock.indexOf("let progEntry"));
  check(/drawArrays\(\s*gl\.TRIANGLES\s*,\s*0\s*,\s*6\s*\)/.test(body),
    "copy 命令必须 TRIANGLES 6（PASS_QUAD 是三角形列表，STRIP 4 会只拷半块对角）");
  check(!/drawArrays\(\s*gl\.TRIANGLE_STRIP/.test(body),
    "copy 命令不得再画 TRIANGLE_STRIP（1444077782 会留下硬边白三角）");
  check(/f\.unique\s*\?\s*layer\.id/.test(rsrc),
    "unique FBO 必须按 layer.id 隔离（同场景两个 motionblur 会串历史缓冲）");

  const id = "1444077782";
  const pkgPath = join(LIB, id, "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = parsePkg(fs.readFileSync(pkgPath));
    const raw = JSON.parse(dec.decode(getEntry(pkg, "scene.json")));
    const parsed = parseScene(raw, {});
    const mblur = parsed.layers.filter((l) => l.isPostProcess && (l.effects || []).some((e) => /motionblur/.test(e.file || "")));
    check(mblur.length >= 2,
      `${id} 应有 ≥2 个 fullscreen motionblur，实得 ${mblur.length}`);
    let copyPasses = 0;
    let uniqueFbos = 0;
    const seen = new Set();
    for (const L of mblur) {
      for (const e of L.effects || []) {
        const file = e.file || "";
        if (!file || seen.has(file)) continue;
        seen.add(file);
        const ej = readJson(pkg, file);
        if (!ej) continue;
        for (const p of ej.passes || []) if (p.command === "copy") copyPasses++;
        for (const f of ej.fbos || []) if (f.unique) uniqueFbos++;
      }
    }
    check(copyPasses >= 1, `${id} motionblur 的 effect.json 应含 copy 命令，实得 ${copyPasses}`);
    check(uniqueFbos >= 1, `${id} motionblur 应带 unique 历史 FBO，实得 ${uniqueFbos}`);
    console.log(`   L. ${id} motionblur×${mblur.length} copy=${copyPasses} unique=${uniqueFbos}`);
  } else {
    console.log("   skip L：库中没有 1444077782");
  }
}

if (errors.length) {
  console.error(`\n发现 ${errors.length} 个问题：`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log("\nverify-groups: all checks passed");
