/**
 * verify-editor 的真浏览器部分（`node scripts/verify-editor.mjs --headless` 调用）。
 *
 * 自起 vite（WE_LIBRARY 指向临时库，保存产物不落进真实壁纸库），真 GPU Chrome：
 *   K. 引擎编辑器控制面：在页面里经公开出口 `api/editor` 另挂一个实例（pkg 形态），
 *      逐个 API 断言数值语义（时钟 / 出图 / 拾取 / 活层 / 热改 / 轮廓 / 位移换算）。
 *   L. 编辑器页端到端（松散形态）：真鼠标 / 键盘事件（CDP Input）驱动 —— 树选中、
 *      检视器热改、旋转柄 / 角点 / 平移拖拽、点选与 Alt 轮换、锁定、复制 / 重排 / 删除、
 *      撤销重做、逐帧、导出 PNG、下载 zip、自动保存到项目文件夹、重新打开、⌘S 覆盖。
 *   Q. 新建端到端：空白 / 纯色 / 图片背景模板，选图与拖入（含 webp 转码）加层，撤销重做，
 *      自动保存到项目文件夹，编辑器重新打开与预览渲染页播放 —— 判据是 CDP 截图的真实像素。
 *   R. 自动保存：刷新没有草稿横幅；再打开同一项目文件夹，图层还在。
 *
 * 编辑器页本身不暴露任何调试探针（verify-arch 断言），所以 L 只看 DOM 状态与盘上产物；
 * 需要的几何（手柄位置）由 K 那个同尺寸的旁挂实例经公开 API 算出 —— 两者同一套 fit 数学。
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { ROOT, imp } from "./lib/verify-kit.mjs";

const FIXTURE = process.env.WE_EDITOR_ITEM || "beach";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, eps) => Math.abs(a - b) <= eps;
/** 页内片段：元素在检视器未选中的标签页里就先点开那一页（hidden 的输入框 focus 不上） */
const REVEAL = `const reveal = (el) => { const p = el?.closest('.ed-insp-panel[hidden]'); if (p) document.querySelector('.ed-insp-tab[data-tab="' + p.dataset.tab + '"]').click(); return el; };`;
/** 内置粒子预设（editor/particles.ts PARTICLE_PRESETS）；插件还能再贡献，故只断言这四个都在。 */
const BUILTIN_PRESETS = ["snow", "rain", "embers", "bokeh"];

export async function runEditorHeadless({ check, section, tmpRoot, cleanups, LIB }) {
  var src = path.join(LIB, FIXTURE);
  if (!fs.existsSync(path.join(src, "scene.json")) || !fs.existsSync(path.join(src, "scene.pkg"))) {
    check(false, `夹具 ${FIXTURE} 需要同时有 scene.json 与 scene.pkg（WE_EDITOR_ITEM 可换）`);
    return;
  }
  // 临时库：<fixture> = 完整目录（松散形态优先）；<fixture>-pkg = 只留包（走 pkg 形态）
  var lib = path.join(tmpRoot, "lib-headless");
  fs.cpSync(src, path.join(lib, FIXTURE), { recursive: true });
  var pkgItem = `${FIXTURE}-pkg`;
  fs.mkdirSync(path.join(lib, pkgItem), { recursive: true });
  for (const f of ["project.json", "scene.pkg"]) fs.copyFileSync(path.join(src, f), path.join(lib, pkgItem, f));
  var sceneJson = JSON.parse(fs.readFileSync(path.join(src, "scene.json"), "utf8"));
  var objects = sceneJson.objects;

  var prevLib = process.env.WE_LIBRARY;
  process.env.WE_LIBRARY = lib;
  cleanups.push(() => {
    if (prevLib === undefined) delete process.env.WE_LIBRARY;
    else process.env.WE_LIBRARY = prevLib;
  });
  var port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  var { createServer } = await import("vite");
  var server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  cleanups.push(() => server.close());
  var origin = `http://127.0.0.1:${port}`;

  var { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
  var session = await launchHeadless({ url: "about:blank", task: "verify-editor", width: 1440, height: 900 });
  cleanups.push(() => session.close());
  instrument(session, { width: 1440, height: 900 });
  var cdp = session.pageCdp;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: fs.readFileSync(path.join(ROOT, "scripts/e2e-dir-picker.js"), "utf8"),
  });
  var walkRel = (dir, base, out = []) => {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const abs = path.join(dir, name);
      if (fs.statSync(abs).isDirectory()) walkRel(abs, base, out);
      else out.push(path.relative(base, abs).split(path.sep).join("/"));
    }
    return out;
  };
  var beachFiles = walkRel(path.join(lib, FIXTURE), path.join(lib, FIXTURE));
  var ev = (expr, timeoutMs = 60000) => session.evaluate(expr, { awaitPromise: true, timeoutMs });
  var waitFor = (expr, timeoutMs = 60000) => session.waitFor(expr, { timeoutMs });

  // ---- 真输入（CDP Input：产生可信的 pointer / mouse / key 事件，含指针捕获） ----
  var MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  var mouse = (type, x, y, { buttons = 0, modifiers = 0 } = {}) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, modifiers });
  var click = async ([x, y], modifiers = 0) => {
    await mouse("mouseMoved", x, y, { modifiers });
    await mouse("mousePressed", x, y, { buttons: 1, modifiers });
    await mouse("mouseReleased", x, y, { modifiers });
    await sleep(60);
  };
  var drag = async ([x0, y0], [x1, y1], modifiers = 0, steps = 10) => {
    await mouse("mouseMoved", x0, y0, { modifiers });
    await sleep(50);
    await mouse("mousePressed", x0, y0, { buttons: 1, modifiers });
    for (let i = 1; i <= steps; i++) {
      await mouse("mouseMoved", x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { buttons: 1, modifiers });
      await sleep(16);
    }
    await mouse("mouseReleased", x1, y1, { modifiers });
    await sleep(120);
  };
  var KEYS = { z: [90, "KeyZ"], y: [89, "KeyY"], d: [68, "KeyD"], s: [83, "KeyS"], Delete: [46, "Delete"], a: [65, "KeyA"], c: [67, "KeyC"], v: [86, "KeyV"], x: [88, "KeyX"] };
  var key = async (k, modifiers = 0) => {
    const [vk, code] = KEYS[k];
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(60);
  };
  var clickSel = async (sel) => {
    // 目标在检视器未选中的标签页里：先像用户一样点开那一页
    const tab = await ev(`(() => { const p = document.querySelector(${JSON.stringify(sel)})?.closest('.ed-insp-panel[hidden]'); if (!p) return null; const r = document.querySelector('.ed-insp-tab[data-tab="' + p.dataset.tab + '"]').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    if (tab) await click(tab);
    // 目标在滚动容器（检视器 / 图层树）的视口之外时，真鼠标点不到（elementFromPoint 是 null）：
    // 先像用户一样滚到可见处。block:"nearest" 对已经完整可见的元素不动滚动位置。
    await ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`);
    await sleep(80);
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await click(r);
  };

  // ---- 项目保存位置：默认浏览器存储，真目录必须显式选 ----
  /** 「打开项目」对话框 →「打开本地文件夹…」：只有明确选本机文件夹才走真目录（e2e 假选择器） */
  var openLocal = async () => {
    await clickSel("#tb-open-dir");
    await waitFor(`!!document.querySelector('#vdir-dlg')?.open`, 30000);
    await clickSel("#vdir-local");
  };
  /** 等盘上文件出现（真目录由 e2e 假目录异步镜像到 lib/） */
  var waitFileOnDisk = async (p, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (fs.existsSync(p)) return true;
      await sleep(120);
    }
    return fs.existsSync(p);
  };
  /** 浏览器存储里的工程整份落到本机文件夹（状态栏 / 工程卡那颗按钮）；已经是真目录就直接返回 */
  var saveToLocal = async () => {
    if (!(await ev(`!!localStorage.getItem('webwallgl-vdir-last')`))) return null;
    await clickSel("#st-save");
    await waitFor(`!localStorage.getItem('webwallgl-vdir-last')`, 30000);
    const id = await ev(`sessionStorage.getItem('wwgl-e2e-project')`);
    await waitFileOnDisk(path.join(lib, String(id), "project.json"));
    check(typeof id === "string" && /^editor-/.test(id) && fs.existsSync(path.join(lib, id, "project.json")), `「存到本机文件夹…」：浏览器存储里的工程整份落到真目录（${id}）`);
    return id;
  };

  /** 清掉编辑器自己的 IndexedDB（草稿 + 虚拟工程）与「上次打开」，让 e2e 从干净状态开始 */
  var clearLocalStore = () =>
    ev(`(async () => {
      for (const n of ['webwallgl-editor', 'webwallgl-vdir']) {
        await new Promise((ok) => { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => ok(true); });
      }
      try { localStorage.removeItem('webwallgl-vdir-last'); } catch (e) { /* 无痕 */ }
      return true;
    })()`);

  // ---- 编辑器页 DOM 状态 ----
  var READY = "/首帧就绪|First frame ready/";
  var SAVED = "/保存用时|Save took/";
  var savedCount = () => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${SAVED}.test(d.textContent)).length`);
  var waitSaved = async (before) => {
    await waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${SAVED}.test(d.textContent)).length > ${before}`, 120000);
    await sleep(200);
  };
  var readyCount = () => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length`);
  var errorLines = () => ev(`[...document.querySelectorAll('#ed-con-body > div.error')].map((d) => d.textContent)`);
  var treeNames = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node .ed-node-name')].map((n) => n.textContent)`);
  var selectedName = () => ev(`document.querySelector('#ed-tree .ed-node.selected .ed-node-name')?.textContent ?? null`);
  var numInputs = () => ev(`[...document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')].map((i) => Number(i.value))`);
  var dirtyTitle = () => ev(`document.querySelector('#ed-doc-title').textContent.startsWith('● ')`);
  var canvasRect = () => ev(`(() => { const r = document.querySelector('#ed-stage canvas:not(#ed-overlay)').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  /** 等一次整场景重挂完成（结构编辑 / 撤销重做 / 重新加载） */
  var waitRemount = async (before) => {
    await waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length > ${before}`);
    await waitFor(`!document.querySelector('#tb-export').disabled`);
    await sleep(150);
  };
  var rowCenter = (name) =>
    ev(`(() => { const n = [...document.querySelectorAll('#ed-tree .ed-node')].find((r) => r.querySelector('.ed-node-name').textContent === ${JSON.stringify(name)}); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; })()`);
  var rowButton = (name, cls) =>
    ev(`(() => { const n = [...document.querySelectorAll('#ed-tree .ed-node')].find((r) => r.querySelector('.ed-node-name').textContent === ${JSON.stringify(name)}); const b = n?.querySelector(${JSON.stringify(cls)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  /** 检视器数值框：focus（记 before）→ 改值 → input（热改）→ change（入栈） */
  var setInputs = (values) =>
    ev(`(() => {
      ${REVEAL}
      const ins = [...document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')];
      const v = ${JSON.stringify(values)};
      reveal(ins[0]).focus();
      for (const [i, x] of Object.entries(v)) { ins[i].value = String(x); ins[i].dispatchEvent(new Event('input', { bubbles: true })); }
      for (const i of Object.keys(v)) ins[i].dispatchEvent(new Event('change', { bubbles: true }));
      ins[0].blur();
      return true;
    })()`);
  /** 拦截页面的 <a download>.click()：返回 { name, base64 } */
  var captureDownload = async (trigger) => {
    await ev(`(() => {
      window.__dl = null;
      const orig = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (!this.download) return orig.call(this);
        const name = this.download;
        window.__dl = fetch(this.href).then((r) => r.arrayBuffer()).then((b) => {
          let s = ''; const u = new Uint8Array(b);
          for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
          return { name, base64: btoa(s) };
        });
        HTMLAnchorElement.prototype.click = orig;
      };
      return true;
    })()`);
    await trigger();
    await waitFor(`!!window.__dl`, 60000);
    return ev(`window.__dl`, 120000);
  };

  // ════════════════════════════════════════════════════════════════════════
  // 打开编辑器页（松散形态）
  // ════════════════════════════════════════════════════════════════════════
  var editorReady = `(document.querySelector('#ed-empty .ed-empty-hint')?.textContent || '').length > 8`;
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html` });
  await waitFor(editorReady, 90000);
  await ev(`(() => { window.__e2eMode = 'seed'; window.__e2eSeed = ${JSON.stringify({ base: `${origin}/media/dev/${FIXTURE}/`, paths: beachFiles })}; return true; })()`);
  await openLocal();
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === ${objects.length}`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  await waitFor(`${READY}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await sleep(500);
  var cr = await canvasRect();

  // ════════════════════════════════════════════════════════════════════════
  // K. 引擎编辑器控制面（同页旁挂 pkg 形态实例，尺寸与编辑器画布一致）
  // ════════════════════════════════════════════════════════════════════════
  section(`K. 引擎编辑器控制面（${pkgItem}，pkg 形态，${Math.round(cr.w)}×${Math.round(cr.h)}）`);
  var k = await ev(`(async () => {
    const api = await import('/renderer/src/api/editor.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-6000px;top:0;width:${cr.w}px;height:${cr.h}px';
    document.body.appendChild(host);
    const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${pkgItem}'), fit: 'cover', renderDpr: 1, volume: 0 });
    const ed = api.editorOf(inst);
    window.__verifyK = { api, inst, ed, host };
    const out = { hasEd: !!ed, info: inst.info };
    out.layers = ed.getLayers();
    inst.pause();
    await ed.seek(2.5);
    out.tSeek = ed.time;
    await new Promise((r) => setTimeout(r, 200));
    out.tPausedLater = ed.time;
    await ed.step(3, 60);
    out.tStep = ed.time;
    let seekErr = '';
    try { await ed.seek(NaN); } catch (e) { seekErr = e.message; }
    out.seekErr = seekErr;
    ed.setTimeScale(0.5);
    out.scale = ed.timeScale;
    inst.resume();
    const t0 = ed.time, w0 = performance.now();
    await new Promise((r) => setTimeout(r, 600));
    out.rate = (ed.time - t0) / ((performance.now() - w0) / 1000);
    ed.setTimeScale(1);
    inst.pause();
    const dims = async (b) => { const bmp = await createImageBitmap(b); const d = [bmp.width, bmp.height]; bmp.close(); return d; };
    const png = await ed.capture({ width: 320 });
    out.png = { type: png.type, dims: await dims(png) };
    const jpg = await ed.capture({ width: 640, height: 360, type: 'image/jpeg', quality: 0.8 });
    out.jpg = { type: jpg.type, dims: await dims(jpg) };
    out.full = await dims(await ed.capture({ width: 1920, height: 1080 }));
    await ed.capture({ time: 1, width: 64 });
    out.tCapture = ed.time;
    const pix = async () => {
      const b = await ed.capture({ width: 160, height: 90 });
      const bmp = await createImageBitmap(b);
      const c = new OffscreenCanvas(160, 90); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, 160, 90).data;
    };
    const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 4 * 3); };
    out.props = Object.fromEntries(out.layers.map((l) => [l.id, ed.getLayerProps(l.id)]));
    out.outline = Object.fromEntries(out.layers.map((l) => [l.id, ed.getLayerOutline(l.id)]));
    out.missing = { props: ed.getLayerProps(9999), outline: ed.getLayerOutline(9999) };
    let setErr = '';
    try { await ed.setLayerProps(9999, { alpha: 0 }); } catch (e) { setErr = e.message; }
    out.setErr = setErr;
    const top = out.layers[out.layers.length - 1].id;
    const a = out.outline[top].anchor;
    out.hitAnchor = ed.hitTestAt(a[0], a[1]).map((h) => h.id);
    out.hitOutside = ed.hitTestAt(-50, -50).map((h) => h.id);
    out.delta = ed.screenDeltaToLocal(top, 10, 10);
    await ed.setLayerProps(top, { origin: [960, 540, 0], scale: [0.3, 0.3, 1], angles: [0, 0, 0] });
    out.afterSet = ed.getLayerProps(top);
    out.outlineSet = ed.getLayerOutline(top);
    await ed.setLayerProps(top, { visible: false });
    out.hitHidden = ed.hitTestAt(${cr.w / 2}, ${cr.h / 2}).map((h) => h.id);
    out.hitHiddenIncl = ed.hitTestAt(${cr.w / 2}, ${cr.h / 2}, { includeHidden: true }).map((h) => h.id);
    out.visAfter = ed.getLayerProps(top).visible;
    await ed.setLayerProps(top, { visible: true, alpha: 0.25, color: [1, 0.5, 0] });
    out.tint = ed.getLayerProps(top);
    const base = await pix();
    for (const l of out.layers) await ed.setLayerProps(l.id, { visible: false });
    out.diffHidden = diff(base, await pix());
    for (const l of out.layers) await ed.setLayerProps(l.id, { visible: true });
    out.diffBack = diff(base, await pix());
    out.top = top;
    return out;
  })()`, 120000);

  check(k.hasEd, "editorOf：场景实例给出控制面");
  check(k.layers.length === objects.length, `getLayers：图层数与 scene.json 一致（${k.layers.length}）`);
  check(k.layers.every((l, i) => l.id === objects[i].id && l.name === (objects[i].name ?? "") && l.index === i), "getLayers：id / 名称 / 绘制序号与文档对应");
  check(near(k.tSeek, 2.5, 1e-3) && near(k.tPausedLater, 2.5, 1e-3), `seek：暂停中定格到目标时间且不走（${k.tSeek.toFixed(3)} → ${k.tPausedLater.toFixed(3)}）`);
  check(near(k.tStep, 2.55, 2e-3), `step(3, 60)：暂停中逐帧推进 3/60s（${k.tStep.toFixed(4)}）`);
  check(/invalid time/.test(k.seekErr), "seek(NaN) 拒绝");
  check(k.scale === 0.5 && near(k.rate, 0.5, 0.15), `setTimeScale(0.5)：时钟按半速走（实测 ${k.rate.toFixed(2)}×）`);
  check(k.png.type === "image/png" && k.png.dims.join("x") === `320x${Math.round((320 * cr.h) / cr.w)}`, `capture：只给宽按画布比例出图（${k.png.dims.join("x")}）`);
  check(k.jpg.type === "image/jpeg" && k.jpg.dims.join("x") === "640x360", "capture：指定 jpeg 与尺寸");
  check(k.full.join("x") === "1920x1080", "capture：可出超过画布的场景原生分辨率");
  check(near(k.tCapture, 1, 1e-3), "capture({time})：先 seek 再出图");
  var top = k.top;
  var topObj = objects.find((o) => o.id === top);
  var vec = (s) => String(s).trim().split(/\s+/).map(Number);
  var [ox, oy] = vec(topObj.origin);
  var [sx] = vec(topObj.scale);
  check(near(k.props[top].origin[0], ox, 1e-3) && near(k.props[top].origin[1], oy, 1e-3) && near(k.props[top].scale[0], sx, 1e-3), "getLayerProps：变换与 scene.json 一致");
  var cssPerWorld = cr.w / 1920;
  var anchorTop = k.outline[top].anchor;
  check(near(anchorTop[0], ox * cssPerWorld, 1.5) && near(anchorTop[1], (1080 - oy) * cssPerWorld, 1.5), `getLayerOutline：锚点 = 世界坐标按 cover 换算到画布 CSS（${anchorTop.map((v) => v.toFixed(1))}）`);
  check(k.missing.props === null && k.missing.outline === null && /not found/.test(k.setErr), "不存在的图层：读返回 null、写拒绝");
  check(k.hitAnchor[0] === top, `hitTestAt：锚点处最上层命中（${JSON.stringify(k.hitAnchor)}）`);
  check(k.hitOutside.length === 0, "hitTestAt：画布外无命中");
  check(near(k.delta[0], 10 / cssPerWorld, 1e-3) && near(k.delta[1], -10 / cssPerWorld, 1e-3), `screenDeltaToLocal：CSS 位移 → 世界位移（y 翻转，${k.delta.map((v) => v.toFixed(2))}）`);
  check(near(k.afterSet.origin[0], 960, 1e-6) && near(k.afterSet.scale[0], 0.3, 1e-6), "setLayerProps → getLayerProps 读回一致");
  check(near(k.outlineSet.anchor[0], cr.w / 2, 1) && near(k.outlineSet.anchor[1], cr.h / 2, 1), "setLayerProps 后轮廓跟着走（锚点到画布中心）");
  check(!k.hitHidden.includes(top) && k.hitHiddenIncl.includes(top) && k.visAfter === false, "隐藏层：缺省不参与拾取，includeHidden 时参与");
  check(near(k.tint.alpha, 0.25, 1e-6) && k.tint.color.join(",") === "1,0.5,0", "alpha / color 热改读回一致");
  check(k.diffHidden > 10 && k.diffBack < 2, `可见性热改真的改了画面（全隐藏逐像素差 ${k.diffHidden.toFixed(1)}，恢复后差 ${k.diffBack.toFixed(2)}）`);
  {
    const r = await ev(`(async () => { const { inst, ed } = window.__verifyK; inst.destroy({ releasePkgCache: true }); let err = ''; try { await ed.seek(1); } catch (e) { err = e.message; } return { layers: ed.getLayers().length, hit: ed.hitTestAt(1, 1).length, props: ed.getLayerProps(1), err }; })()`);
    check(r.layers === 0 && r.hit === 0 && r.props === null && !!r.err, "销毁后：读接口返回空、写接口报错");
  }

  // ════════════════════════════════════════════════════════════════════════
  // M12. 引擎写测（真浏览器）：增量装配 / GL overlay 的「出帧 A/B」
  //
  // A/B 口径：同一夹具、同一暂停帧号（pause + seek 2.5 + 两个 rAF），
  // 只差**一个**引擎操作；每次都走同一个 ed.capture({width:160,height:90})，
  // 再按逐像素三通道绝对差均值比。四组对照：
  //   - 负对照：同一状态连出两张 → 差 = 这个夹具的**帧间噪声底**；
  //   - 正对照：隐藏最上层 → 必须显著高于噪声底（画面确实由引擎操作决定）；
  //   - 复原对照：热增删 / 热重排做完反向操作 → 必须落回噪声带；
  //   - 增量对照：单步操作（热增挪位 / 热重排）必须高出噪声带。
  // GL overlay 的 A/B 是「切换后端不影响编辑器出图」（overlay 画在 capture 之后）。
  //
  // 为什么不判「逐位 0」：夹具 beach 的 palms / clouds 是**模型动画层**，引擎的模型 /
  // 关键帧推进吃渲染循环的实时 dt，`pause()` + `seek()` 只冻住场景时钟、冻不住它，
  // 于是同一状态连出两张本身就有 ~0.75 的逐像素差（K 段对同一现象用的口径是
  // `diffBack < 2`）。所以 M12 的 A/B 判据统一落在噪声带内 = 「没有可归因于本次操作的
  // 变化」，分辨力交给正 / 增量对照。AB_BAND 取 3 = 实测噪声底的 4 倍。
  // ════════════════════════════════════════════════════════════════════════
  section(`M12. 引擎写测：增量装配 / GL overlay 出帧 A/B（${pkgItem}）`);
  var m12 = await ev(
    `(async () => {
    const api = await import('/renderer/src/api/editor.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-6000px;top:0;width:${cr.w}px;height:${cr.h}px';
    document.body.appendChild(host);
    const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${pkgItem}'), fit: 'cover', renderDpr: 1, volume: 0 });
    const ed = api.editorOf(inst);
    const raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pix = async () => {
      const b = await ed.capture({ width: 160, height: 90 });
      const bmp = await createImageBitmap(b);
      const c = new OffscreenCanvas(160, 90); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      return Array.from(g.getImageData(0, 0, 160, 90).data);
    };
    const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]) + Math.abs(a[i+1] - b[i+1]) + Math.abs(a[i+2] - b[i+2]); return s / (a.length / 4 * 3); };
    const out = {};
    inst.pause();
    await ed.seek(2.5);
    await raf();
    const layers0 = ed.getLayers();
    const n0 = layers0.length;
    const idTop = layers0[n0 - 1].id;
    const idBottom = layers0[0].id;
    out.n0 = n0; out.idTop = idTop; out.idBottom = idBottom;
    const f0 = await pix();
    out.diffRepeat = diff(f0, await pix());
    out.outlineTop = ed.getLayerOutline(idTop) || { anchor: [0, 0], corners: null };
    out.anchorTop = out.outlineTop.anchor;
    await ed.setLayerProps(idTop, { visible: false });
    out.diffHide = diff(f0, await pix());
    await ed.setLayerProps(idTop, { visible: true });
    out.diffShowBack = diff(f0, await pix());
    // ---- B1 热增：复制最上层（不重建场景）----
    out.hotCheck = ed.canHotAddLayer({ duplicateOf: idTop });
    const added = await ed.addLayer({ duplicateOf: idTop });
    out.added = { id: added.id, name: added.name, kind: added.kind, index: added.index };
    out.src = { id: idTop, name: layers0[n0 - 1].name, kind: layers0[n0 - 1].kind };
    out.nAfterAdd = ed.getLayers().length;
    out.orderAfterAdd = ed.getLayers().map((l) => l.id);
    out.outlineDup = ed.getLayerOutline(added.id);
    out.hitAfterAdd = ed.hitTestAt(out.anchorTop[0], out.anchorTop[1]).map((h) => h.id);
    out.frameAfterAdd = diff(f0, await pix());
    // 复制层与源层同位同纹：只改 alpha 是「同色叠同色」，画面可能逐位不变。
    // 改成把它挪走 + 缩小，合成结果必然可用作「新层确实参与了这一帧」的证据。
    await ed.setLayerProps(added.id, { origin: [480, 270, 0], scale: [0.3, 0.3, 1] });
    out.frameAfterAddMove = diff(f0, await pix());
    await ed.removeLayer(added.id);
    out.nAfterRemove = ed.getLayers().length;
    out.frameAfterRemove = diff(f0, await pix());
    out.propsAfterRemove = ed.getLayerProps(added.id);
    out.hitAfterRemove = ed.hitTestAt(out.anchorTop[0], out.anchorTop[1]).map((h) => h.id);
    // 新层插到底（toIndex=0）
    const addedBottom = await ed.addLayer({ duplicateOf: idTop, toIndex: 0 });
    out.orderAfterAddBottom = ed.getLayers()[0].id === addedBottom.id;
    await ed.removeLayer(addedBottom.id);
    out.frameAfterRemoveBottom = diff(f0, await pix());
    // ---- B1 热重排：底 → 顶，再搬回来 ----
    await ed.reorderLayer(idBottom, n0 - 1);
    out.orderAfterReorder = ed.getLayers().map((l) => l.id);
    out.frameAfterReorder = diff(f0, await pix());
    await ed.reorderLayer(idBottom, 0);
    out.orderReorderBack = ed.getLayers().map((l) => l.id);
    out.frameReorderBack = diff(f0, await pix());
    // 契约（renderer/src/api/types.ts reorderLayer）：toIndex = 目标下标、越界夹到端点；
    // 目标即原位 = 空操作 **resolve**（不报失败），只有「层不存在」「下标非有限数」才 reject。
    const orderBeforeNoop = ed.getLayers().map((l) => l.id).join(',');
    let noopErr = '';
    try { await ed.reorderLayer(idTop, n0); } catch (e) { noopErr = e.message; }
    out.noopErr = noopErr;
    out.orderBeforeNoop = orderBeforeNoop;
    out.orderAfterNoop = ed.getLayers().map((l) => l.id).join(',');
    let badIndexErr = '';
    try { await ed.reorderLayer(idTop, NaN); } catch (e) { badIndexErr = e.message; }
    out.badIndexErr = badIndexErr;
    let missingErr = '';
    try { await ed.removeLayer(99999); } catch (e) { missingErr = e.message; }
    out.missingErr = missingErr;
    // ---- B3 边界：装配期没有脚本的挂点不能凭空热增（这一步仍走整场景重挂）----
    let scriptErr = '';
    try { await ed.setLayerScript(idTop, 'origin', 'export function update(v) { return v; }'); } catch (e) { scriptErr = e.message; }
    out.scriptErr = scriptErr;
    // ---- B2 overlay：默认 2d，显式切 gl ----
    out.modeDefault = ed.getOverlayMode();
    out.statsDefault = ed.getOverlayStats();
    out.modeGl = await ed.setOverlayMode('gl');
    await ed.setOverlayTarget(idTop);
    await raf(); await raf();
    out.statsGl = ed.getOverlayStats();
    out.frameGl = diff(f0, await pix());
    out.drawsBeforeNull = ed.getOverlayStats().draws;
    await ed.setOverlayTarget(null);
    await raf();
    out.statsNoTarget = ed.getOverlayStats();
    out.modeBack = await ed.setOverlayMode('2d');
    out.statsBack = ed.getOverlayStats();
    out.frameAfter2d = diff(f0, await pix());
    out.layersEnd = ed.getLayers().length;
    inst.destroy({ releasePkgCache: true });
    host.remove();
    return out;
  })()`,
    180000,
  );

  var AB_BAND = 3;
  check(m12.diffRepeat < AB_BAND, `M12/A-B 负对照：同一暂停帧号连出两张 = 夹具噪声底（逐像素差 ${m12.diffRepeat.toFixed(2)} < ${AB_BAND}）`);
  check(m12.diffHide > 10, `M12/A-B 正对照：隐藏最上层画面真的变（逐像素差 ${m12.diffHide.toFixed(1)}）`);
  check(m12.diffShowBack < AB_BAND, `M12/A-B 复原对照：显示回来落回噪声带（差 ${m12.diffShowBack.toFixed(2)}）`);
  check(m12.hotCheck.ok === true && m12.hotCheck.reason === "", `M12/B1 canHotAddLayer：复制一个普通图片层可热增（${m12.hotCheck.reason || "ok"}）`);
  check(
    m12.nAfterAdd === m12.n0 + 1 && m12.orderAfterAdd[m12.n0] === m12.added.id,
    `M12/B1 addLayer(duplicateOf)：不重建场景就多一层，且落在末尾（${m12.nAfterAdd} 层）`,
  );
  check(
    m12.added.name === m12.src.name && m12.added.kind === m12.src.kind && m12.added.id !== m12.src.id,
    `M12/B1 addLayer：新层是源层的副本但换了 id（${m12.src.name} #${m12.src.id} → #${m12.added.id}）`,
  );
  check(
    m12.hitAfterAdd.includes(m12.added.id) &&
      !!m12.outlineDup &&
      near(m12.outlineDup ? m12.outlineDup.anchor[0] : NaN, m12.anchorTop[0], 1) &&
      near(m12.outlineDup ? m12.outlineDup.anchor[1] : NaN, m12.anchorTop[1], 1),
    `M12/B1 热增的层真的进了渲染与拾取集合（锚点 ${(m12.outlineDup ? m12.outlineDup.anchor : []).map((v) => v.toFixed(1))}）`,
  );
  check(
    m12.frameAfterAddMove > 1,
    `M12/B1 热增层参与合成：把它挪到左上角缩小后画面跟着变（逐像素差 ${m12.frameAfterAddMove.toFixed(1)}）`,
  );
  check(
    m12.nAfterRemove === m12.n0 && m12.propsAfterRemove === null && !m12.hitAfterRemove.includes(m12.added.id),
    "M12/B1 removeLayer：层从活层表、拾取集合里整体消失",
  );
  check(
    m12.frameAfterRemove < AB_BAND && m12.frameAfterRemoveBottom < AB_BAND,
    `M12/B1 出帧 A/B：热增删反向做完落回原帧噪声带（末位删差 ${m12.frameAfterRemove.toFixed(2)}，底位删差 ${m12.frameAfterRemoveBottom.toFixed(2)}）`,
  );
  check(m12.orderAfterAddBottom === true, "M12/B1 addLayer(toIndex:0)：插到数组首位 = 最先画");
  check(
    m12.orderAfterReorder[m12.n0 - 1] === m12.idBottom && m12.orderAfterReorder[0] !== m12.idBottom,
    `M12/B1 reorderLayer：底层搬到末位 = 绘制序最上（${m12.orderAfterReorder.join(",")}，画面差 ${m12.frameAfterReorder.toFixed(1)}）`,
  );
  check(
    m12.orderReorderBack.join(",") === m12.orderAfterAdd.slice(0, m12.n0).join(",") && m12.frameReorderBack < AB_BAND,
    `M12/B1 出帧 A/B：热重排反向做完顺序与画面都复原（差 ${m12.frameReorderBack.toFixed(2)}）`,
  );
  check(
    m12.noopErr === '' && m12.orderAfterNoop === m12.orderBeforeNoop && /下标非法/.test(m12.badIndexErr) && /不存在/.test(m12.missingErr),
    `M12/B1 同位重排 = 空操作（resolve 且顺序不变）；非有限下标 / 不存在的层被拒绝（${m12.badIndexErr} / ${m12.missingErr}）`,
  );
  check(
    /挂点不存在或不可热替换/.test(m12.scriptErr),
    "M12/B3 边界：装配期没有脚本的挂点热替换被显式拒绝（给新挂点加脚本仍走整场景重挂）",
  );
  check(
    m12.modeDefault === "2d" && m12.statsDefault.glOk === false && m12.statsDefault.draws === 0,
    `M12/B2 缺省后端是 2d（页面现有行为不变）：${m12.modeDefault} / glOk=${m12.statsDefault.glOk}`,
  );
  check(
    m12.modeGl === "gl" && m12.statsGl.mode === "gl" && m12.statsGl.glOk === true && m12.statsGl.target === m12.idTop,
    `M12/B2 setOverlayMode("gl") 后 GL pass 真的建起来了（reason=${JSON.stringify(m12.statsGl.reason)}）`,
  );
  check(
    m12.statsGl.segments > 0 && m12.statsGl.draws >= 1,
    `M12/B2 GL overlay 在出帧时提交线段（每出一帧交一次）：segments=${m12.statsGl.segments} draws=${m12.statsGl.draws}`,
  );
  check(
    m12.frameGl < AB_BAND,
    `M12/B2 出帧 A/B：切到 GL 后端不影响编辑器出图（overlay 画在 capture 之后，差 ${m12.frameGl.toFixed(2)}）`,
  );
  check(
    m12.statsNoTarget.segments === 0 && m12.statsNoTarget.draws === m12.drawsBeforeNull,
    "M12/B2 取消选中后不再提交线段（没有目标就不画）",
  );
  check(
    m12.modeBack === "2d" && m12.statsBack.mode === "2d" && m12.statsBack.glOk === false && m12.frameAfter2d < AB_BAND,
    `M12/B2 切回 2d 时 GL pass 被释放，画面仍落回噪声带（差 ${m12.frameAfter2d.toFixed(2)}，回退路径可用）`,
  );
  check(m12.layersEnd === m12.n0, "M12/B1 整段 A/B 结束后图层数与开局一致（没有留下热增层）");

  // ════════════════════════════════════════════════════════════════════════
  // L. 编辑器页端到端
  // ════════════════════════════════════════════════════════════════════════
  section(`L. 编辑器页端到端（${FIXTURE}，松散形态）`);
  check(JSON.stringify(await treeNames()) === JSON.stringify(objects.map((o) => o.name)), "图层树与 scene.json 一致");
  check(/松散|loose/i.test(await ev(`document.querySelector('#st-form').textContent`)), "状态栏显示松散形态");
  var topName = topObj.name;
  var toPage = ([x, y]) => [cr.x + x, cr.y + y];

  // 树选中 + 检视器热改（把顶层挪到画布中心、缩到 0.3，手柄全部落在画面内）
  await click(await rowCenter(topName));
  check((await selectedName()) === topName, "点树行选中图层");
  check(!(await dirtyTitle()), "未编辑时标题无脏标记");
  await setInputs({ 0: 960, 1: 540, 3: 0.3, 4: 0.3 });
  await sleep(200);
  var v = await numInputs();
  check(v[0] === 960 && v[1] === 540 && v[3] === 0.3, "检视器数值框热改");
  check(await dirtyTitle(), "编辑后标题出现脏标记");
  check(!(await ev(`document.querySelector('#tb-undo').disabled`)), "编辑后撤销可用");

  // 手柄几何：旁挂实例同尺寸、同 fit，同样的属性 → 同样的轮廓
  var geo = await ev(`(async () => {
    const api = window.__verifyK.api;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-6000px;top:0;width:${cr.w}px;height:${cr.h}px';
    document.body.appendChild(host);
    const inst = await api.mount(host, { source: api.httpSource('${origin}/media/dev/${pkgItem}'), fit: 'cover', renderDpr: 1, volume: 0 });
    const ed = api.editorOf(inst);
    await ed.setLayerProps(${top}, { origin: [960, 540, 0], scale: [0.3, 0.3, 1] });
    const o = ed.getLayerOutline(${top});
    window.__verifyK = { api, inst, ed, host };
    return o;
  })()`, 120000);
  var c = geo.corners;
  var anchor = geo.anchor;
  var mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
  var ctr = [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
  var len = Math.hypot(mid[0] - ctr[0], mid[1] - ctr[1]) || 1;
  var rotHandle = [mid[0] + ((mid[0] - ctr[0]) / len) * 22, mid[1] + ((mid[1] - ctr[1]) / len) * 22];

  // 悬停光标
  await mouse("mouseMoved", ...toPage(rotHandle));
  await sleep(120);
  check((await ev(`document.querySelector('#ed-stage').dataset.cursor`)) === "rotate", "悬停旋转柄：光标切到旋转");
  await mouse("mouseMoved", ...toPage(c[2]));
  await sleep(120);
  check((await ev(`document.querySelector('#ed-stage').dataset.cursor`)) === "scale", "悬停角点：光标切到缩放");

  // 旋转柄：绕锚点顺时针拖 90°
  var r0 = [rotHandle[0] - anchor[0], rotHandle[1] - anchor[1]];
  await drag(toPage(rotHandle), toPage([anchor[0] - r0[1], anchor[1] + r0[0]]));
  v = await numInputs();
  check(near(v[8], -90, 1.5), `旋转柄顺时针拖 90° → 角度 ${v[8]}°`);
  await clickSel("#tb-undo");
  await sleep(150);
  v = await numInputs();
  check(near(v[8], 0, 1e-6), "撤销旋转 → 角度回 0");
  await key("z", MOD.meta | MOD.shift);
  await sleep(150);
  v = await numInputs();
  check(near(v[8], -90, 1.5), "⇧⌘Z 重做旋转");
  await key("z", MOD.meta);
  await sleep(150);

  // 角点缩放：右下角外拖到锚点距离的两倍（Shift 等比）
  var to2 = [anchor[0] + (c[2][0] - anchor[0]) * 2, anchor[1] + (c[2][1] - anchor[1]) * 2];
  await drag(toPage(c[2]), toPage(to2), MOD.shift);
  v = await numInputs();
  check(near(v[3], 0.6, 0.02) && near(v[4], 0.6, 0.02), `角点 Shift 外拖一倍 → 缩放 ${v[3]} / ${v[4]}`);

  // 平移：从层内部拖 (+60, +30) CSS 像素
  var before = await numInputs();
  var inside = [anchor[0] + 5, anchor[1] + 5];
  await drag(toPage(inside), toPage([inside[0] + 60, inside[1] + 30]));
  v = await numInputs();
  check(near(v[0] - before[0], 60 / cssPerWorld, 2) && near(v[1] - before[1], -30 / cssPerWorld, 2), `平移拖拽 → origin Δ(${(v[0] - before[0]).toFixed(1)}, ${(v[1] - before[1]).toFixed(1)})`);
  var movedAnchor = [anchor[0] + 60, anchor[1] + 30];

  // 画面点选 + Alt 轮换
  await click(toPage([cr.w - 3, 3]));
  var picked1 = await selectedName();
  await click(toPage(movedAnchor));
  check((await selectedName()) === topName, "点画面选中最上层");
  await click(toPage(movedAnchor), MOD.alt);
  var altPicked = await selectedName();
  check(altPicked !== topName && altPicked !== null, `Alt+点击同一位置轮换到下一层（${altPicked}）`);
  check(picked1 !== topName, "点别处不会误选到被移走的层");

  // 锁定：不可点选、不可拖、检视器只读
  await click(await rowCenter(topName));
  await click(await rowButton(topName, ".ed-lock"));
  check(await ev(`document.querySelector('#ed-inspector fieldset.ed-form').disabled`), "锁定后检视器只读");
  var lockedBefore = await numInputs();
  await drag(toPage(movedAnchor), toPage([movedAnchor[0] + 80, movedAnchor[1]]));
  await click(await rowCenter(topName));
  check(JSON.stringify(await numInputs()) === JSON.stringify(lockedBefore), "锁定层拖不动");
  await click(toPage(movedAnchor));
  check((await selectedName()) !== topName, "锁定层不参与画面点选");
  await click(await rowCenter(topName));
  await click(await rowButton(topName, ".ed-lock"));
  check(!(await ev(`document.querySelector('#ed-inspector fieldset.ed-form').disabled`)), "解锁后恢复可编辑");

  var hiddenTools = await ev(`[...document.querySelectorAll('.ed-layer-tools button')].filter((b) => { const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !(hit === b || b.contains(hit)); }).map((b) => b.id)`);
  check(hiddenTools.length === 0, `图层工具条按钮都在可视区内、点得到${hiddenTools.length ? `（被挤掉：${hiddenTools.join(", ")}）` : ""}`);

  // 结构编辑：复制 / 重排 / 删除 + 撤销重做（整场景重挂）
  var n0 = objects.length;
  var rc = await readyCount();
  await clickSel("#ly-dup");
  await waitRemount(rc);
  var names = await treeNames();
  check(names.length === n0 + 1 && names.some((n) => n.startsWith(topName) && n !== topName), `复制图层：树多一行（${names.at(-1)}）`);
  check(new RegExp(`${n0 + 1}`).test(await ev(`document.querySelector('#st-layers').textContent`)), "复制后引擎重挂出的图层数 +1");
  var copyName = await selectedName();
  check(copyName !== topName && copyName.startsWith(topName), "复制后选中副本");
  rc = await readyCount();
  await clickSel("#ly-up");
  await waitRemount(rc);
  names = await treeNames();
  check(names.indexOf(copyName) === names.indexOf(topName) - 1, "前移一层：副本挪到原层之前");
  rc = await readyCount();
  await key("z", MOD.meta);
  await waitRemount(rc);
  names = await treeNames();
  check(names.indexOf(copyName) === names.indexOf(topName) + 1, "撤销重排：顺序复原");
  rc = await readyCount();
  await key("Delete");
  await waitRemount(rc);
  check((await treeNames()).length === n0, "Delete 键删除选中层");
  rc = await readyCount();
  await key("z", MOD.meta);
  await waitRemount(rc);
  check((await treeNames()).length === n0 + 1, "撤销删除：副本回来");
  rc = await readyCount();
  await key("d", MOD.meta);
  await waitRemount(rc);
  check((await treeNames()).length === n0 + 2, "⌘D 再复制一层");
  rc = await readyCount();
  await clickSel("#tb-undo");
  await waitRemount(rc);
  check((await treeNames()).length === n0 + 1, "撤销按钮撤掉结构编辑");
  await click(await rowCenter(topName));
  v = await numInputs();
  check(near(v[3], 0.6, 0.02) && near(v[0] - before[0], 60 / cssPerWorld, 2), "结构编辑重挂后，先前的属性热改仍在（文档驱动）");

  // 逐帧
  var t0 = await ev(`parseFloat(document.querySelector('#tl-time').textContent)`);
  await clickSel("#tl-next");
  await sleep(200);
  var t1 = await ev(`parseFloat(document.querySelector('#tl-time').textContent)`);
  check(await ev(`!document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`), "逐帧时自动暂停");
  check(t1 > t0 || near(t1, t0 + 1 / 60, 0.02), `下一帧推进时钟（${t0} → ${t1}）`);

  // 导出 PNG（场景原生分辨率）
  var png = await captureDownload(() => clickSel("#tb-export"));
  var pngBuf = Buffer.from(png.base64, "base64");
  check(/\.png$/.test(png.name) && pngBuf.readUInt32BE(16) === 1920 && pngBuf.readUInt32BE(20) === 1080, `导出 PNG：1920×1080（${png.name}）`);

  // 下载 zip
  var zipDl = await captureDownload(async () => {
    await clickSel("#tb-pack");
    await clickSel("#export-zip");
  });
  var zipPath = path.join(tmpRoot, "e2e.zip");
  fs.writeFileSync(zipPath, Buffer.from(zipDl.base64, "base64"));
  var ut = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  var ul = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  var zipNames = (ul.stdout || "").trim().split("\n");
  check(ut.status === 0, "下载的 zip 通过 unzip -t");
  check(["scene.json", "project.json", "preview.jpg"].every((n) => zipNames.includes(n)) && zipNames.some((n) => n.startsWith("materials/")), `zip 内含入口 / 工程 / 封面 / 资源（${zipNames.length} 个）`);
  await waitFor(`!document.querySelector('#tb-pack').disabled`);

  // 自动保存进项目文件夹（⌘S 立刻再写一次）
  var sc = await savedCount();
  await key("s", MOD.meta);
  await waitSaved(sc);
  var savedId = await ev(`sessionStorage.getItem('wwgl-e2e-project')`);
  var saved = [savedId];
  check(typeof savedId === "string" && /^editor-/.test(savedId), `项目文件夹（${savedId}）`);
  var itemDir = path.join(lib, saved[0]);
  var sScene = JSON.parse(fs.readFileSync(path.join(itemDir, "scene.json"), "utf8"));
  var sProject = JSON.parse(fs.readFileSync(path.join(itemDir, "project.json"), "utf8"));
  check(fs.existsSync(path.join(itemDir, ".webwallgl-editor")), "条目带编辑器标记");
  check(sScene.objects.length === n0 + 1, "盘上 scene.json 含副本层");
  var sTop = sScene.objects.find((o) => o.name === topName);
  var [sx1, , ] = vec(typeof sTop.scale === "object" ? sTop.scale.value : sTop.scale);
  var [ox1] = vec(typeof sTop.origin === "object" ? sTop.origin.value : sTop.origin);
  check(near(sx1, 0.6, 0.02) && near(ox1, before[0] + 60 / cssPerWorld, 2), "盘上 scene.json 含拖拽 / 缩放结果");
  check(sProject.type === "scene" && sProject.file === "scene.json" && sProject.preview === "preview.jpg", "project.json 指向文档与新封面");
  var jpg = fs.readFileSync(path.join(itemDir, "preview.jpg"));
  check(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 2000, `封面是有效 JPEG（${(jpg.length / 1024).toFixed(0)} KB）`);
  check(!(await dirtyTitle()) && /已保存|Saved/.test(await ev(`document.querySelector('#st-save').textContent`)), "保存后脏标记清除，状态栏显示已保存");

  // ⌘S：重复上次目标，覆盖同一条目
  await click(await rowCenter(copyName));
  rc = await readyCount();
  await key("Delete");
  await waitRemount(rc);
  sc = await savedCount();
  await key("s", MOD.meta);
  await waitSaved(sc);
  var afterCmdS = fs.readdirSync(lib).filter((n) => /^editor-/.test(n));
  var sScene2 = JSON.parse(fs.readFileSync(path.join(itemDir, "scene.json"), "utf8"));
  check(afterCmdS.includes(saved[0]) && (await ev(`sessionStorage.getItem('wwgl-e2e-project')`)) === saved[0] && sScene2.objects.length === n0, "⌘S 覆盖同一项目文件夹（不新建）");

  var errs1 = await errorLines();
  check(errs1.length === 0, `编辑全程控制台无错误${errs1.length ? `：${errs1.slice(0, 2).join(" / ")}` : ""}`);

  // 重新打开保存产物
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html` });
  await waitFor(editorReady, 90000);
  await ev(`(() => { window.__e2eMode = 'open'; window.__e2eOpen = ${JSON.stringify(saved[0])}; return true; })()`);
  await openLocal();
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === ${n0}`, 90000);
  await waitFor(`${READY}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  check(JSON.stringify(await treeNames()) === JSON.stringify(sScene2.objects.map((o) => o.name)), "重新打开：图层树与盘上 scene.json 一致");
  await click(await rowCenter(topName));
  v = await numInputs();
  check(near(v[3], 0.6, 0.02) && near(v[0], ox1, 0.01), "重新打开：引擎读到保存的变换");
  var errs2 = await errorLines();
  check(errs2.length === 0, `重新打开无错误${errs2.length ? `：${errs2.slice(0, 2).join(" / ")}` : ""}`);

  await session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/reopened.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/reopened.jpg`);

  await runCreateAndDraft({ check, section, tmpRoot, lib, origin, cdp, ev, waitFor, click, drag, mouse, key, clickSel, MOD, captureDownload, openLocal, saveToLocal, waitFileOnDisk, clearLocalStore, helpers: { readyCount, waitRemount, savedCount, waitSaved, treeNames, selectedName, numInputs, setInputs, dirtyTitle, canvasRect, rowCenter, rowButton, errorLines }, objects, session });

  await session.close();
  await server.close();
}

/** RGB 行缓冲 → PNG（无依赖编码：IHDR + 单块 IDAT + IEND） */
/** RGB 行缓冲 → PNG（无依赖编码：IHDR + 单块 IDAT + IEND）。AQ 段的「外圈纯色 + 内部棋盘格」夹具用它现编 */
function rgbPng(w, h, raw) {
  var chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 上半 top、下半 bottom 的 RGB PNG */
export function stripePng(w, h, top, bottom) {
  var stride = w * 3 + 1;
  var raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const c = y < h / 2 ? top : bottom;
    for (let x = 0; x < w; x++) raw.set(c, y * stride + 1 + x * 3);
  }
  return rgbPng(w, h, raw);
}

/**
 * Q. 新建端到端 + R. 草稿。判据只看 DOM、盘上产物与真实像素（CDP 截图），
 * 不读编辑器页任何内部状态。
 */
async function runCreateAndDraft(ctx) {
  // ---- 真机容错（本机 headless 有环境级抖动：页面/CDP 偶发卡死；一条断言的等待失败不该带走整轮）----
  // 每段独立 try/catch：一段中断只记一条 ✗，后面的段照跑。只有「探针也打不通」连续两次才判页面失效、剩余段快速跳过
  //（普通「等条件超时」时页面往往还活着 —— 用探针区分，避免把一条判据失败误判成页面失效而跳过几十段）。
  const HL_TRANSPORT = /连接已关闭|Not attached to an active page|Target closed|Session closed|ECONNREFUSED|Chrome 沙箱|Cdp/;
  const hlState = { aborts: [], dead: false, streak: 0, skipped: 0 };
  /** 页面还活着吗：一次 5s 的 evaluate 探针。 */
  async function hlAlive() {
    try {
      await ctx.ev("1 + 1", 5000);
      return true;
    } catch {
      return false;
    }
  }
  async function hlAbort(tag, name, err) {
    const msg = err && err.message ? err.message : String(err);
    hlState.aborts.push({ tag, name, msg });
    check(false, `真机段中断：${name} —— ${msg}（该段余下步骤跳过，后续段继续跑）`);
    hlState.streak = (await hlAlive()) ? 0 : hlState.streak + 1;
    if (hlState.streak >= 2 && !hlState.dead) {
      hlState.dead = true;
      console.log(`  — 页面已连续 ${hlState.streak} 段无响应（最近：${name}${HL_TRANSPORT.test(msg) ? `；传输级：${msg}` : ""}），剩余段快速跳过`);
    }
  }
  function hlSkip(tag, name) {
    if (hlState.skipped++ === 0) check(false, `页面 / 传输已失效，后续真机段未执行（首个：${name}）`);
    else console.log(`  — 跳过（页面 / 传输已失效）：${name}`);
  }

  var { check, section, tmpRoot, lib, origin, cdp, ev, waitFor, click, drag, mouse, key, clickSel, MOD, captureDownload, openLocal, saveToLocal, waitFileOnDisk, clearLocalStore, helpers: h, objects } = ctx;
  var RED = [220, 30, 30];
  var BLUE = [30, 30, 220];
  var BG = "#336699";
  var BG_RGB = [0x33, 0x66, 0x99];
  var stripePath = path.join(tmpRoot, "stripe.png");
  fs.writeFileSync(stripePath, stripePng(400, 200, RED, BLUE));

  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  var setFiles = async (sel, files) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files });
  };
  /** 页面坐标处 4×4 平均色（真实合成结果，经 CDP 截图） */
  var pixelAt = async ([x, y]) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: x - 2, y: y - 2, width: 4, height: 4, scale: 1 } });
    return ev(`(async () => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      return s.map((v) => Math.round(v / (d.length / 4)));
    })()`);
  };
  var close = (a, b, eps) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
  var isRed = (c) => c[0] > 170 && c[1] < 80 && c[2] < 80;
  var isBlue = (c) => c[2] > 170 && c[0] < 80 && c[1] < 80;
  var isGreen = (c) => c[1] > 170 && c[0] < 80 && c[2] < 80;
  var bannerShown = () => ev(`!document.querySelector('#ed-draft').hidden`);
  var EDITOR = `${origin}/editor/index.html`;
  var gotoEditor = async (query = "") => {
    await cdp.send("Page.navigate", { url: `${EDITOR}${query}` });
    await waitFor(`(document.querySelector('#ed-empty .ed-empty-hint')?.textContent || '').length > 8`, 90000);
  };
  /** 再打开某个已经自动保存过的项目文件夹（不靠 ?item=） */
  var reopen = async (id, query = "") => {
    await gotoEditor(query);
    await ev(`(() => { window.__e2eMode = 'open'; window.__e2eOpen = ${JSON.stringify(id)}; return true; })()`);
    await openLocal();
  };
  /**
   * ⌘S 落盘，返回条目 id。
   * 新建工程默认落在浏览器存储里，所以先「存到本机文件夹…」绑到真目录（这一段要断言盘上文件）；
   * 已经绑在真目录上时这一步是空操作。
   */
  var saveLoose = async () => {
    await saveToLocal();
    const sc = await h.savedCount();
    await key("s", MOD.meta);
    await h.waitSaved(sc);
    const id = await ev(`sessionStorage.getItem('wwgl-e2e-project')`);
    // 写入是「浏览器 → 宿主」的 HTTP 往返，落盘可能有几毫秒延迟：与 saveToLocal 一样轮询等，
    // 失败时把目录内容打进消息，便于区分「真的没写」与「写晚了 / 写了别的名字」。
    const scenePath = path.join(lib, String(id), "scene.json");
    await waitFileOnDisk(scenePath);
    const dirPath = path.join(lib, String(id));
    const listed = fs.existsSync(dirPath) ? fs.readdirSync(dirPath).sort().join(",") || "(空)" : "(目录不存在)";
    check(typeof id === "string" && /^editor-/.test(id) && fs.existsSync(scenePath), `项目写入文件夹（${id}；盘上：${listed}）`);
    return id;
  };
  /** 编辑器画布上世界坐标（y 朝上）→ 页面坐标；场景 16:9 与舞台同比例 */
  var worldToPage = (cr, [wx, wy], W = 1920, H = 1080) => {
    const k = Math.max(cr.w / W, cr.h / H);
    return [cr.x + cr.w / 2 + (wx - W / 2) * k, cr.y + cr.h / 2 - (wy - H / 2) * k];
  };
  var newBlank = async (color) => {
    await clickSel("#tb-new");
    await ev(`(() => { document.querySelector('#new-res').value = '1920x1080'; document.querySelector('#new-color').value = '${color}'; return true; })()`);
    const rc = await h.readyCount();
    await clickSel("#new-blank");
    await h.waitRemount(rc);
  };
  var addImage = async (file) => {
    const rc = await h.readyCount();
    await clickSel("#ly-add");
    await setFiles("#in-image", [file]);
    await h.waitRemount(rc);
  };

  section("Q. 新建端到端（模板 → 图片层 → 自动保存 → 编辑器与预览播放）");
  if (hlState.dead) hlSkip("Q", "Q. 新建端到端（模板 → 图片层 → 自动保存 → 编辑器与预览播放）"); else try {
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await clearLocalStore();
  await gotoEditor();
  check(!(await ev(`document.querySelector('#tb-new').disabled`)), "「新建」按钮可用");
  // 中间空态的「新建项目」按钮（用户报过「点了没反应」）：真实点击会冒泡到 document 上「点到菜单外就关」的
  // 监听，而 #empty-new 不在 #new-menu 里 —— 修法是先 stopPropagation 再 openNewMenu。这里用真点击锁住它。
  var emptyBtn = await ev(`(() => { const b = document.querySelector('#empty-new'); return !!b && b.offsetParent !== null; })()`);
  check(emptyBtn, "没有项目时中间是空态，「新建项目」按钮可见");
  await clickSel("#empty-new");
  check(await ev(`!document.querySelector('#new-menu').hidden`), "点空态「新建项目」真的弹出模板菜单（不再被 document 的关闭监听当场关掉）");
  await ev(`document.body.click()`);
  check(await ev(`document.querySelector('#new-menu').hidden`), "点菜单外面照旧收起（菜单自己的关闭语义没被改坏）");
  await clickSel("#tb-new");
  check(await ev(`!document.querySelector('#new-menu').hidden`), "点「新建」弹出模板菜单");
  check((await ev(`[...document.querySelectorAll('#new-res option')].map((o) => o.value)`)).join() === "1920x1080,2560x1440,3840x2160,1080x1920", "分辨率预设齐全");
  await clickSel("#tb-new");
  check(await ev(`document.querySelector('#new-menu').hidden`), "再点一次收起菜单");

  await newBlank(BG);
  var cr = await h.canvasRect();
  check((await h.treeNames()).length === 0 && /0/.test(await ev(`document.querySelector('#st-layers').textContent`)), "空白模板：图层树为空、引擎 0 层");
  check(/1920×1080/.test(await ev(`document.querySelector('#st-res').textContent`)) && /松散|loose/i.test(await ev(`document.querySelector('#st-form').textContent`)), "状态栏：1920×1080、松散形态");
  check(/未命名|Untitled/.test(await ev(`document.querySelector('#ed-doc-title').textContent`)) && !(await h.dirtyTitle()), "标题 = 未命名壁纸，新建即干净（无脏标记）");
  var bg0 = await pixelAt(worldToPage(cr, [960, 540]));
  check(close(bg0, BG_RGB, 10), `画面 = 所选背景色（期望 ${BG_RGB}，实得 ${bg0}）`);
  check(!(await ev(`document.querySelector('#ly-add').disabled`)) && !(await ev(`document.querySelector('#tb-pack').disabled`)), "新建后「添加图片」「导出」可用");

  // 选图加层：400×200，上红下蓝，放在中心、不缩放
  await addImage(stripePath);
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && (await h.selectedName()) === "stripe", "选图后树里多一层「stripe」并选中");
  // addImage 里的 waitRemount 可能已跨过 AUTOSAVE_MS=400ms（机器忙时），此时脏标记已被自动保存清掉；
  // 两者都是「编辑已生效」的合法终态，故二者取一。
  var dirtyAfterImage = await h.dirtyTitle();
  var savedAfterImage = /已保存|Saved/.test(await ev(`document.querySelector('#st-save').textContent`));
  check(dirtyAfterImage || savedAfterImage, `加图后出现脏标记（或 400ms 内已自动保存落盘：dirty=${dirtyAfterImage} saved=${savedAfterImage}）`);
  var v = await h.numInputs();
  check(v[0] === 960 && v[1] === 540 && v[3] === 1, `新图层在场景中心、原尺寸（origin ${v[0]},${v[1]} scale ${v[3]}）`);
  var topPt = worldToPage(cr, [960 + 150, 540 + 50]);
  var botPt = worldToPage(cr, [960 + 150, 540 - 50]);
  var outPt = worldToPage(cr, [200, 200]);
  var cTop = await pixelAt(topPt);
  var cBot = await pixelAt(botPt);
  check(isRed(cTop) && isBlue(cBot), `引擎真画出图片且不上下颠倒（上 ${cTop} / 下 ${cBot}）`);
  check(close(await pixelAt(outPt), BG_RGB, 10), "图片外仍是背景色");

  // 撤销 / 重做加层
  var rc = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rc);
  check((await h.treeNames()).length === 0 && close(await pixelAt(topPt), BG_RGB, 10), "撤销添加：图层与画面都回到空白");
  rc = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(rc);
  check((await h.treeNames()).length === 1 && isRed(await pixelAt(topPt)), "重做添加：图片回来");

  // 拖入 webp（页面里现做），验证非 png/jpg 转码 + 拖放加层
  rc = await h.readyCount();
  await ev(`(async () => {
    const c = new OffscreenCanvas(200, 200); const g = c.getContext('2d'); g.fillStyle = 'rgb(30,220,30)'; g.fillRect(0, 0, 200, 200);
    const file = new File([await c.convertToBlob({ type: 'image/webp', quality: 1 })], 'green.webp', { type: 'image/webp' });
    const dt = new DataTransfer(); dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await h.waitRemount(rc);
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe", "green"]), "拖入图片 → 追加为最上层");
  // 避开锚点十字（新层自动选中，叠加层在锚点画准星）
  var cMid = await pixelAt(worldToPage(cr, [1000, 500]));
  cTop = await pixelAt(topPt);
  check(isGreen(cMid) && isRed(cTop), `新层盖在上面，旧层未被遮住的部分照常显示（中 ${cMid} / 旁 ${cTop}）`);

  var saved = [await saveLoose()];
  var dir = path.join(lib, saved[0]);
  var scene = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
  check(scene.general.clearcolor === "0.200 0.400 0.600" && scene.objects.length === 2, "盘上 scene.json：背景色 + 两个图片层");
  var need = ["models/editor/stripe.json", "materials/editor/stripe.json", "materials/editor/stripe.png", "models/editor/green.json", "materials/editor/green.json", "materials/editor/green.png", "preview.jpg", "project.json"];
  check(need.every((f) => fs.existsSync(path.join(dir, f))), "盘上资源齐全（两组模型 / 材质 / 源图 + 封面 + 工程）");
  check(Buffer.compare(fs.readFileSync(path.join(dir, "materials/editor/stripe.png")), fs.readFileSync(stripePath)) === 0, "png 源图逐字节原样保存");
  var g = fs.readFileSync(path.join(dir, "materials/editor/green.png"));
  check(g.readUInt32BE(0) === 0x89504e47 && g.readUInt32BE(16) === 200, "webp 转成 png 保存（200×200）");
  check(!fs.readdirSync(path.join(dir, "materials/editor")).some((n) => n.endsWith(".webp")), "不留引擎读不了的 webp");
  var errsQ = await h.errorLines();
  check(errsQ.length === 0, `新建全程控制台无错误${errsQ.length ? `：${errsQ.slice(0, 2).join(" / ")}` : ""}`);

  // 编辑器重新打开
  await reopen(saved[0]);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(`${"/首帧就绪|First frame ready/"}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await new Promise((r) => setTimeout(r, 400));
  var cr2 = await h.canvasRect();
  check(isRed(await pixelAt(worldToPage(cr2, [1110, 590]))) && isGreen(await pixelAt(worldToPage(cr2, [960, 540]))), "编辑器重新打开：画面与保存前一致");

  // 测试台渲染页播放（与资源管理器同一条加载链）
  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${saved[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vp = await ev(`({ w: innerWidth, h: innerHeight })`);
  var benchRect = { x: 0, y: 0, w: vp.w, h: vp.h };
  var layerNames = await ev(`window.__sceneLayers.map((l) => l.name)`);
  check(JSON.stringify(layerNames) === JSON.stringify(["stripe", "green"]), "测试台渲染页：两层都装配出来");
  var bTop = await pixelAt(worldToPage(benchRect, [1110, 590]));
  var bBot = await pixelAt(worldToPage(benchRect, [1110, 490]));
  var bMid = await pixelAt(worldToPage(benchRect, [960, 540]));
  var bOut = await pixelAt(worldToPage(benchRect, [300, 540]));
  check(isRed(bTop) && isBlue(bBot) && isGreen(bMid), `测试台渲染页：图片内容与位置正确（上 ${bTop} / 下 ${bBot} / 中 ${bMid}）`);
  check(close(bOut, BG_RGB, 10), `测试台渲染页：背景色正确（${bOut}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/new-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/new-in-bench.jpg`);

  // 「以图片为背景」模板：铺满（cover），新建即带内容
  await gotoEditor();
  await clickSel("#tb-new");
  var rcBg = await h.readyCount();
  await clickSel("#new-image");
  await setFiles("#in-image", [stripePath]);
  await h.waitRemount(rcBg);
  check(await ev(`document.querySelector('#new-menu').hidden`), "选完图片后模板菜单自动收起");
  var crBg = await h.canvasRect();
  var bgUp = await pixelAt(worldToPage(crBg, [150, 900]));
  var bgDown = await pixelAt(worldToPage(crBg, [150, 150]));
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && (await h.dirtyTitle()), "图片背景模板：一层背景图、带脏标记（有内容可丢）");
  check(isRed(bgUp) && isBlue(bgDown), `图片背景铺满整个场景（左上 ${bgUp} / 左下 ${bgDown}）`);
  // 这个临时工程默认也落在浏览器存储里：清干净，免得下面刷新时弹出「上次的工程」恢复横幅
  await clearLocalStore();

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("Q", "Q. 新建端到端（模板 → 图片层 → 自动保存 → 编辑器与预览播放）", err); }
  section("R. 项目自动保存（刷新不靠草稿；再打开文件夹图层还在）");
  if (hlState.dead) hlSkip("R", "R. 项目自动保存（刷新不靠草稿；再打开文件夹图层还在）"); else try {
  await gotoEditor();
  check(!(await bannerShown()), "打开编辑器没有草稿横幅");
  {
    const rcE = await h.readyCount();
    await openLocal();
    await h.waitRemount(rcE);
    check((await h.treeNames()).length === 0 && /1920×1080/.test(await ev(`document.querySelector('#st-res').textContent`)), "「打开项目」选空文件夹：在里面新建空白项目");
    const idE = await saveLoose();
    check(fs.existsSync(path.join(lib, idE, "project.json")), "空文件夹项目写出 scene.json / project.json");
    await gotoEditor();
  }
  await newBlank("#202020");
  await addImage(stripePath);
  var idR = await saveLoose();
  check(!(await h.dirtyTitle()) && !(await bannerShown()), "写入文件夹后脏标记清除，仍然没有草稿横幅");
  await gotoEditor();
  await new Promise((r) => setTimeout(r, 400));
  check(!(await bannerShown()), "刷新后没有草稿横幅");
  await reopen(idR);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  var cr3 = await h.canvasRect();
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && !(await h.dirtyTitle()), "再打开项目文件夹：图层还在，已是保存态");
  check(isRed(await pixelAt(worldToPage(cr3, [1110, 590]))) && close(await pixelAt(worldToPage(cr3, [200, 200])), [0x20, 0x20, 0x20], 10), "再打开后画面一致（图片与背景色都在文件夹里）");
  await click(await h.rowCenter("stripe"));
  await h.setInputs({ 0: 777, 1: 333 });
  var idR2 = await saveLoose();
  check(idR2 === idR, "继续编辑仍写回同一文件夹");
  await reopen(idR);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  await click(await h.rowCenter("stripe"));
  var vR = await h.numInputs();
  check(near(vR[0], 777, 1e-6) && near(vR[1], 333, 1e-6), `再打开读到刚保存的变换（origin ${vR[0]},${vR[1]}）`);
  var errsR = await h.errorLines();
  check(errsR.length === 0, `自动保存流程无错误${errsR.length ? `：${errsR.slice(0, 2).join(" / ")}` : ""}`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("R", "R. 项目自动保存（刷新不靠草稿；再打开文件夹图层还在）", err); }
  section("R2. 新建默认落浏览器存储（真目录只在明确选本机文件夹时才用）");
  if (hlState.dead) hlSkip("R2", "R2. 新建默认落浏览器存储（真目录只在明确选本机文件夹时才用）"); else try {
  await gotoEditor();
  await newBlank("#123456");
  check(
    await ev(
      `document.querySelector('#st-save').classList.contains('is-clickable') && /浏览器存储/.test(document.querySelector('#st-save').title)`,
    ),
    "新建后状态栏写「浏览器存储 · 自动保存」，并提示点它可存到本机文件夹",
  );
  check(await ev(`document.querySelector('#proj-save-local') !== null`), "工程卡给出「存到本机文件夹…」按钮");
  await addImage(stripePath);
  {
    const sc = await h.savedCount();
    await key("s", MOD.meta);
    await h.waitSaved(sc);
  }
  var vdirId = await ev(`localStorage.getItem('webwallgl-vdir-last')`);
  check(typeof vdirId === "string" && /^vdir-/.test(vdirId), `⌘S 直接写进浏览器存储（${vdirId}）`);
  check(!fs.existsSync(path.join(lib, String(vdirId))), "没有落进任何本机文件夹（真目录必须显式选）");
  check(!(await bannerShown()), "正在编辑时没有恢复横幅");
  await gotoEditor();
  await waitFor(`!document.querySelector('#ed-draft').hidden`, 30000);
  var bannerText = await ev(`document.querySelector('#ed-draft-text').textContent`);
  check(/未命名|Untitled/.test(bannerText), `刷新后给出「上次的工程…还在」恢复横幅（${bannerText}）`);
  await clickSel("#draft-restore");
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]), "点「恢复」后图层还在（浏览器存储里的工程刷新能找回）");
  check(
    await ev(`/浏览器存储/.test(document.querySelector('#st-save').title)`),
    "恢复后仍然绑定浏览器存储（没有悄悄改成真目录）",
  );
  var idLocal = await saveToLocal();
  check(
    typeof idLocal === "string" && idLocal !== vdirId && fs.existsSync(path.join(lib, idLocal, "scene.json")),
    `「存到本机文件夹…」把整份另存为真目录（${idLocal}）`,
  );
  await gotoEditor();
  await new Promise((r) => setTimeout(r, 600));
  check(!(await bannerShown()), "存到本机文件夹后刷新不再提示浏览器存储里的旧工程");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("R2", "R2. 新建默认落浏览器存储（真目录只在明确选本机文件夹时才用）", err); }
  section("T. 效果库端到端（空白 → 图片层 + 2 个内置效果 → 存库 → 测试台出帧一致）");
  if (hlState.dead) hlSkip("T", "T. 效果库端到端（空白 → 图片层 + 2 个内置效果 → 存库 → 测试台出帧一致）"); else try {
  var fxNames = () => ev(`[...document.querySelectorAll('.ed-fx-item')].map((e) => e.dataset.fxId)`);
  var fxAct = async (js) => {
    const r0 = await h.readyCount();
    await ev(`(() => { ${js}; return true; })()`);
    await h.waitRemount(r0);
  };
  var fxAdd = (id) => fxAct(`const s = document.querySelector('#fx-add'); s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
  var fxSet = (i, param, value) =>
    fxAct(`const el = document.querySelector('.ed-fx-item[data-fx-index="${i}"] input[data-param="${param}"]'); el.value = '${value}'; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var fxBtn = (i, cls) => fxAct(`document.querySelector('.ed-fx-item[data-fx-index="${i}"] .${cls}').click()`);
  var undoRedo = async (shift) => {
    const r0 = await h.readyCount();
    await key("z", shift ? MOD.meta | MOD.shift : MOD.meta);
    await h.waitRemount(r0);
  };

  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#000000");
  await addImage(stripePath);
  var crT = await h.canvasRect();
  var tTop = worldToPage(crT, [1110, 590]);
  var tBot = worldToPage(crT, [1110, 490]);
  var tOut = worldToPage(crT, [300, 540]);
  // 选项数 = 1 个占位 + effectCatalog.list()（内置 14 个 + examples/plugins 贡献的 fx-crt / fx-glow）
  // ⇒ 断言「内置 14 个一个不少」，不锁死总数，插件多寡不影响这条。
  var fxOpts = await ev(`[...document.querySelectorAll('#fx-add option')].map((o) => o.value)`);
  var BUILTIN_FX = ["tint", "adjust", "vignette", "blur", "wave", "scroll", "pulse", "outline", "glow", "chroma", "pixelate", "shine", "fade", "audiobars"];
  check(
    (await ev(`!!document.querySelector('.ed-fx') && !document.querySelector('#fx-add').disabled`)) &&
      fxOpts[0] === "" &&
      BUILTIN_FX.every((id) => fxOpts.includes(id)),
    `选中图片层：检视器有「效果」分组，下拉列出全部 14 个内置效果（实得 ${fxOpts.length} 项：${fxOpts.join(",")}）`,
  );
  check((await fxNames()).length === 0, "初始无效果");

  await fxAdd("tint");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint"]) && (await h.selectedName()) === "stripe", "添加「颜色叠加」：列表一项，选中仍是该层");
  var tint0 = await pixelAt(tTop);
  var tintWant = RED.map((c, i) => Math.round(c * 0.5 + [255, 115, 51][i] * 0.5));
  check(close(tint0, tintWant, 6), `缺省橙色 50% 叠在红色上（期望 ${tintWant}，实得 ${tint0}）`);
  await fxSet(0, "color", "#00ff00");
  await fxSet(0, "amount", "1");
  var g1 = await pixelAt(tTop);
  var g2 = await pixelAt(tBot);
  check(isGreen(g1) && isGreen(g2), `改成绿色、强度 1：上下两半都变绿（上 ${g1} / 下 ${g2}）`);
  check(await ev(`document.querySelector('.ed-fx-item[data-fx-index="0"] input[data-param="amount"]').value === '1' && document.querySelector('.ed-fx-item[data-fx-index="0"] input[data-param="color"]').value === '#00ff00'`), "重挂后面板显示改后的参数");

  await fxAdd("adjust");
  await fxSet(1, "brightness", "-0.5");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint", "adjust"]), "第二个效果「色彩调整」排在后面");
  var dim = await pixelAt(tTop);
  check(dim[0] < 30 && dim[2] < 30 && dim[1] > 100 && dim[1] < 160, `效果链串联：先绿再压暗一半（实得 ${dim}）`);
  check(close(await pixelAt(tOut), [0, 0, 0], 8), "效果只作用在图层上，背景不受影响");

  await fxBtn(1, "ed-fx-up");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["adjust", "tint"]), "上移：顺序对调");
  var swapped = await pixelAt(tTop);
  check(isGreen(swapped) && swapped[1] > 200, `先压暗再整色替换成绿 → 纯绿（实得 ${swapped}），顺序真的影响出帧`);
  await undoRedo(false);
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint", "adjust"]) && close(await pixelAt(tTop), dim, 12), "撤销上移：顺序与画面复原");

  await fxBtn(1, "ed-fx-eye");
  var off = await pixelAt(tTop);
  check(await ev(`document.querySelector('.ed-fx-item[data-fx-index="1"]').classList.contains('hidden-layer')`) && isGreen(off) && off[1] > 200, `停用「色彩调整」：画面回到亮绿（${off}）`);
  await undoRedo(false);
  check(close(await pixelAt(tTop), dim, 12), "撤销停用：压暗回来");

  await fxBtn(1, "ed-fx-del");
  check((await fxNames()).length === 1 && isGreen(await pixelAt(tTop)), "移除第二个效果");
  await undoRedo(false);
  check((await fxNames()).length === 2 && close(await pixelAt(tTop), dim, 12), "撤销移除：效果与参数一并回来");
  var editorTop = await pixelAt(tTop);
  var editorBot = await pixelAt(tBot);

  var savedT = [await saveLoose()];
  var dirT = path.join(lib, savedT[0]);
  var sceneT = JSON.parse(fs.readFileSync(path.join(dirT, "scene.json"), "utf8"));
  var effs = sceneT.objects[0]?.effects ?? [];
  check(effs.length === 2 && effs[0].file === "effects/wwgl_tint/effect.json" && effs[1].file === "effects/wwgl_adjust/effect.json", "盘上 scene.json：图层带两条效果，顺序正确");
  check(effs[0].passes[0].constantshadervalues.color === "0 1 0" && effs[0].passes[0].constantshadervalues.amount === 1 && effs[1].passes[0].constantshadervalues.brightness === -0.5, "盘上参数：颜色 \"0 1 0\"、强度 1、亮度 -0.5");
  var fxFiles = ["tint", "adjust"].flatMap((id) => [`effects/wwgl_${id}/effect.json`, `materials/effects/wwgl_${id}.json`, `shaders/effects/wwgl_${id}.frag`, `shaders/effects/wwgl_${id}.vert`]);
  check(fxFiles.every((f) => fs.existsSync(path.join(dirT, f))), "盘上效果文件齐全（两个效果各四件，产物自包含）");
  check(!fs.existsSync(path.join(dirT, "effects")) || fs.readdirSync(path.join(dirT, "effects")).length === 2, "没用到的效果不进产物");
  var errsT = await h.errorLines();
  check(errsT.length === 0, `效果编辑全程控制台无错误${errsT.length ? `：${errsT.slice(0, 2).join(" / ")}` : ""}`);

  await reopen(savedT[0]);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(`${"/首帧就绪|First frame ready/"}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await click(await h.rowCenter("stripe"));
  await waitFor(`document.querySelectorAll('.ed-fx-item').length === 2`, 20000);
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint", "adjust"]) && (await ev(`document.querySelector('.ed-fx-item[data-fx-index="1"] input[data-param="brightness"]').value`)) === "-0.5", "编辑器重新打开：面板认回两个效果与参数");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedT[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpT = await ev(`({ w: innerWidth, h: innerHeight })`);
  var benchT = { x: 0, y: 0, w: vpT.w, h: vpT.h };
  var bTopT = await pixelAt(worldToPage(benchT, [1110, 590]));
  var bBotT = await pixelAt(worldToPage(benchT, [1110, 490]));
  var bOutT = await pixelAt(worldToPage(benchT, [300, 540]));
  check(close(bTopT, editorTop, 12) && close(bBotT, editorBot, 12), `★ 测试台出帧与编辑器预览一致（测试台 ${bTopT} / ${bBotT}，编辑器 ${editorTop} / ${editorBot}）`);
  check(close(bOutT, [0, 0, 0], 8), "测试台：背景不受效果影响");
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/effects-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/effects-in-bench.jpg`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("T", "T. 效果库端到端（空白 → 图片层 + 2 个内置效果 → 存库 → 测试台出帧一致）", err); }
  section("U. 脚本面板端到端（预检 → 应用 → 运行期错误回显 → 撤销 → 存库 → 测试台）");
  if (hlState.dead) hlSkip("U", "U. 脚本面板端到端（预检 → 应用 → 运行期错误回显 → 撤销 → 存库 → 测试台）"); else try {
  var scSel = (target) => `.ed-script[data-target="${target}"]`;
  var scType = async (target, src) => {
    await ev(`(() => { const ta = document.querySelector('${scSel(target)} .ed-script-src'); ta.value = ${JSON.stringify(src)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await new Promise((r) => setTimeout(r, 300));
  };
  var scStatus = (target) => ev(`(() => { const s = document.querySelector('${scSel(target)} .ed-script-status'); return { cls: s.className, text: s.textContent }; })()`);
  var scApply = async (target) => {
    const r0 = await h.readyCount();
    await ev(`(() => { document.querySelector('${scSel(target)} .ed-script-apply').click(); return true; })()`);
    await h.waitRemount(r0);
  };
  var BGU = [0x20, 0x20, 0x20];
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#202020");
  await addImage(stripePath);
  var crU = await h.canvasRect();
  var uTop = worldToPage(crU, [1110, 590]);
  check(await ev(`!!document.querySelector('.ed-scripts') && document.querySelectorAll('.ed-script').length === 0 && !document.querySelector('#script-add').disabled`), "检视器有「脚本」分组，图片层初始无脚本、可添加");
  check((await ev(`[...document.querySelectorAll('#script-add option')].map((o) => o.value).filter(Boolean)`)).join() === "origin,scale,angles,visible,alpha,color,brightness", "图片层可加脚本的字段列表");

  await fxAct(`const s = document.querySelector('#script-add'); s.value = 'alpha'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
  check(await ev(`!!document.querySelector('${scSel("alpha")}') && /export function update\\(value\\)/.test(document.querySelector('${scSel("alpha")} .ed-script-src').value)`), "添加 alpha 脚本：出现编辑框，内容为 update(value) 模板");
  var st = await scStatus("alpha");
  check(/ok/.test(st.cls) && /update/.test(st.text) && (await ev(`document.querySelector('${scSel("alpha")} .ed-script-apply').disabled`)), `模板预检通过、未改动时「应用」不可点（${st.text}）`);
  check(isRed(await pixelAt(uTop)), "模板原样返回 value：画面不变");

  await scType("alpha", "export function update(value) {\n\treturn value +;\n}\n");
  st = await scStatus("alpha");
  check(/err/.test(st.cls) && /第 2 行|Line 2/.test(st.text) && (await ev(`document.querySelector('${scSel("alpha")} .ed-script-apply').disabled`)), `语法错误：实时标红并定位第 2 行，「应用」不可点（${st.text}）`);
  await scType("alpha", "let x = 1;\n");
  check(/warn/.test((await scStatus("alpha")).cls), "没有入口：黄色提醒引擎会忽略");

  await scType("alpha", "export function update(value) {\n\treturn 0;\n}\n");
  await scApply("alpha");
  check(close(await pixelAt(uTop), BGU, 10), "应用 `return 0`：图层隐去，露出背景（新脚本当帧生效）");
  check((await h.dirtyTitle()) && (await ev(`document.querySelector('${scSel("alpha")} .ed-script-apply').disabled`)), "应用后带脏标记，编辑框与文档一致（「应用」回到不可点）");
  await undoRedo(false);
  check(isRed(await pixelAt(uTop)) && /return value;/.test(await ev(`document.querySelector('${scSel("alpha")} .ed-script-src').value`)), "撤销：画面与脚本源码都回到模板");
  await undoRedo(true);
  check(close(await pixelAt(uTop), BGU, 10), "重做：脚本再次生效");

  await scType("alpha", "export function update(value) {\n\tconst o = null;\n\treturn o.x;\n}\n");
  await scApply("alpha");
  await waitFor(`!document.querySelector('${scSel("alpha")} .ed-script-issues').hidden`, 10000);
  var issueText = await ev(`document.querySelector('${scSel("alpha")} .ed-script-issues').textContent`);
  check(/\[update\]/.test(issueText) && /第 3 行|line 3/.test(issueText) && /×\d+/.test(issueText), `运行期错误回显在该挂点下：阶段 / 源码行 / 次数（${issueText.split("\n")[0]}）`);
  check(isRed(await pixelAt(uTop)), "脚本出错时字段保持快照值（图层照常显示）");
  check((await ev(`document.querySelector('#ed-con-body').textContent`)).includes("alpha' 失败"), "诊断流（控制台）同时有文案");

  // 未应用的改动在切换选中后保留
  rc = await h.readyCount();
  await ev(`(async () => {
    const c = new OffscreenCanvas(100, 100); const g = c.getContext('2d'); g.fillStyle = 'rgb(30,220,30)'; g.fillRect(0, 0, 100, 100);
    const file = new File([await c.convertToBlob({ type: 'image/png' })], 'dot.png', { type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(file);
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    return true;
  })()`);
  await h.waitRemount(rc);
  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('${scSel("alpha")}')`, 10000);
  await scType("alpha", "export function update(value) {\n\treturn 0.5;\n}\n");
  await click(await h.rowCenter("dot"));
  await waitFor(`!document.querySelector('${scSel("alpha")}')`, 10000);
  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('${scSel("alpha")}')`, 10000);
  check(/return 0\.5;/.test(await ev(`document.querySelector('${scSel("alpha")} .ed-script-src').value`)) && !(await ev(`document.querySelector('${scSel("alpha")} .ed-script-apply').disabled`)), "未应用的改动：切换选中再回来仍在，「应用」可点");
  await scApply("alpha");
  var half = await pixelAt(uTop);
  var halfWant = RED.map((c, i) => Math.round(c * 0.5 + BGU[i] * 0.5));
  check(close(half, halfWant, 14), `return 0.5：半透明叠在背景上（期望 ≈${halfWant}，实得 ${half}）`);
  check(await ev(`document.querySelector('${scSel("alpha")} .ed-script-issues').hidden`), "重挂后旧错误清空（登记表随装配重建）");

  var savedU = [await saveLoose()];
  var sceneU = JSON.parse(fs.readFileSync(path.join(lib, savedU[0], "scene.json"), "utf8"));
  var alphaU = sceneU.objects.find((o) => o.name === "stripe")?.alpha;
  check(alphaU && /return 0\.5;/.test(alphaU.script) && alphaU.value === 1, `盘上 scene.json：alpha 包装为 {script, value: 1}（${JSON.stringify(alphaU)?.slice(0, 60)}）`);
  var errsU = (await h.errorLines()).filter((l) => !/alpha' 失败/.test(l));
  check(errsU.length === 0, `脚本流程除故意制造的错误外无错误${errsU.length ? `：${errsU.slice(0, 2).join(" / ")}` : ""}`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedU[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpU = await ev(`({ w: innerWidth, h: innerHeight })`);
  var bHalf = await pixelAt(worldToPage({ x: 0, y: 0, w: vpU.w, h: vpU.h }, [1110, 590]));
  check(close(bHalf, half, 12), `测试台：脚本照样运行，出帧与编辑器一致（测试台 ${bHalf} / 编辑器 ${half}）`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("U", "U. 脚本面板端到端（预检 → 应用 → 运行期错误回显 → 撤销 → 存库 → 测试台）", err); }
  section("V. 用户属性端到端（声明 → 绑定 → 拖值热更 → 撤销 → combo 显隐 → 删除解绑 → 存库 → 测试台）");
  if (hlState.dead) hlSkip("V", "V. 用户属性端到端（声明 → 绑定 → 拖值热更 → 撤销 → combo 显隐 → 删除解绑 → 存库 → 测试台）"); else try {
  var BGV = [0x20, 0x20, 0x20];
  var settle = () => new Promise((r) => setTimeout(r, 400));
  var ctl = (name) => `.ed-prop[data-prop="${name}"] .ed-fx-param [data-prop="${name}"]`;
  var upDeclare = async (name, type) => {
    await ev(`(() => {
      const n = document.querySelector('#up-name'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#up-type').value = '${type}';
      document.querySelector('#up-add').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.ed-prop[data-prop="${name}"]')`, 10000);
    await settle();
  };
  var upFire = (name, value, type) =>
    ev(`(() => { const el = document.querySelector('${ctl(name)}'); el.value = '${value}'; el.dispatchEvent(new Event('${type}', { bubbles: true })); return true; })()`);
  var deselect = async (cr) => {
    await click(worldToPage(cr, [300, 540]));
    await waitFor(`!!document.querySelector('.ed-props')`, 10000);
  };
  var bindSel = async (field, value) => {
    const r0 = await h.readyCount();
    await ev(`(() => { const s = document.querySelector('.ed-bindings select[data-bind="${field}"]'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await h.waitRemount(r0);
  };
  var mix = (a, k) => RED.map((c, i) => Math.round(c * k + BGV[i] * (1 - k)));

  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#202020");
  await addImage(stripePath);
  var crV = await h.canvasRect();
  var vTop = worldToPage(crV, [1110, 590]);
  check(await ev(`!!document.querySelector('.ed-bindings') && /用户属性|user properties/i.test(document.querySelector('.ed-bindings').textContent)`), "图层检视器有「属性绑定」分组，没有属性时提示先去场景级声明");
  await deselect(crV);
  check(await ev(`document.querySelector('#up-add').disabled && document.querySelectorAll('#up-type option').length === 5`), "不选图层：出现「用户属性」面板，五种类型，名字为空时「声明」不可点");
  await ev(`(() => { const n = document.querySelector('#up-name'); n.value = '1bad'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check(await ev(`document.querySelector('#up-add').disabled`), "非标识符名字：「声明」不可点");

  var rDecl = await h.readyCount();
  await upDeclare("op", "slider");
  check((await h.readyCount()) === rDecl && (await h.dirtyTitle()), "声明 slider「op」：热更不重挂，带脏标记");
  check(await ev(`document.querySelector('${ctl("op")}').value === '0.5' && document.querySelector('.ed-prop[data-prop="op"] .ed-prop-range').value === '0 1 0.01'`), "新属性默认 0.5、范围 0 1 0.01");

  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('.ed-bindings select[data-bind="alpha"]')`, 10000);
  check((await ev(`[...document.querySelectorAll('.ed-bindings select')].map((s) => s.dataset.bind)`)).join() === "visible,alpha,brightness,scale,color", "图片层可绑字段：visible / alpha / brightness / scale / color");
  check((await ev(`[...document.querySelectorAll('.ed-bindings select[data-bind="alpha"] option')].map((o) => o.value)`)).join() === ",op" && (await ev(`[...document.querySelectorAll('.ed-bindings select[data-bind="color"] option')].length`)) === 1, "只列类型兼容的属性（alpha 可选 op，color 无可选）");
  await bindSel("alpha", "op");
  var vHalf = await pixelAt(vTop);
  check(close(vHalf, mix(RED, 0.5), 14), `★ alpha 绑 op(0.5)：图层半透明（期望 ≈${mix(RED, 0.5)}，实得 ${vHalf}）`);
  check(await ev(`document.querySelector('.ed-bindings select[data-bind="alpha"]').value === 'op'`), "重挂后绑定下拉显示 op");

  await deselect(crV);
  var rDrag = await h.readyCount();
  await upFire("op", "0", "input");
  await settle();
  var vPrev = await pixelAt(vTop);
  check(close(vPrev, BGV, 10), `★ 拖滑条到 0（input）：画面实时热更、图层隐去（实得 ${vPrev}）`);
  await upFire("op", "0", "change");
  await settle();
  await upFire("op", "1", "change");
  await settle();
  check((await h.readyCount()) === rDrag && isRed(await pixelAt(vTop)), "松手提交（change）：值 0 → 1，全程不重挂、画面跟随");
  await undoRedo(false);
  check(close(await pixelAt(vTop), BGV, 10) && (await ev(`document.querySelector('${ctl("op")}').value`)) === "0", "撤销：值回到 0（面板与画面）");
  await undoRedo(true);
  check(isRed(await pixelAt(vTop)), "重做：值回到 1");

  await upDeclare("mode", "combo");
  check((await ev(`[...document.querySelectorAll('${ctl("mode")} option')].map((o) => o.value)`)).join() === "0,1", "combo 默认两个选项 0 / 1");
  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('.ed-bindings select[data-bind="visible"]')`, 10000);
  check((await ev(`[...document.querySelectorAll('.ed-bindings select[data-bind="visible"] option')].map((o) => o.value)`)).join() === ",op,mode=0,mode=1", "visible 可选 slider（0 / 非 0）与 combo 的每个条件");
  await bindSel("visible", "mode=1");
  check(close(await pixelAt(vTop), BGV, 10), "visible 绑 mode=1、当前值 0：图层隐藏");
  await deselect(crV);
  var rCombo = await h.readyCount();
  await upFire("mode", "1", "change");
  await settle();
  check((await h.readyCount()) === rCombo && isRed(await pixelAt(vTop)), "★ combo 切到 1：图层显示（热更，不重挂）");

  await upFire("op", "0.3", "change");
  await settle();
  var v03 = await pixelAt(vTop);
  check(close(v03, mix(RED, 0.3), 14), `op = 0.3：图层 30% 不透明（实得 ${v03}）`);
  var rDel = await h.readyCount();
  await ev(`(() => { document.querySelector('.ed-prop[data-prop="op"] .ed-prop-del').click(); return true; })()`);
  await h.waitRemount(rDel);
  check(!(await ev(`!!document.querySelector('.ed-prop[data-prop="op"]')`)) && isRed(await pixelAt(vTop)), "删除 op：alpha 解绑回快照 1，图层全不透明");
  await undoRedo(false);
  check(close(await pixelAt(vTop), mix(RED, 0.3), 14) && (await ev(`!!document.querySelector('.ed-prop[data-prop="op"]')`)), "撤销删除：属性与绑定一并回来");
  await undoRedo(true);
  var editorV = await pixelAt(vTop);
  check(isRed(editorV), "重做删除");

  var savedV = [await saveLoose()];
  var sceneV = JSON.parse(fs.readFileSync(path.join(lib, savedV[0], "scene.json"), "utf8"));
  var projV = JSON.parse(fs.readFileSync(path.join(lib, savedV[0], "project.json"), "utf8"));
  var stripeV = sceneV.objects.find((o) => o.name === "stripe");
  check(JSON.stringify(stripeV?.visible?.user) === JSON.stringify({ name: "mode", condition: "1" }) && typeof stripeV.alpha !== "object", `盘上 scene.json：visible 条件绑定保留，alpha 已解绑（${JSON.stringify({ visible: stripeV?.visible, alpha: stripeV?.alpha })}）`);
  var propsV = projV.general?.properties ?? {};
  check(propsV.mode?.type === "combo" && propsV.mode.value === "1" && !("op" in propsV), `盘上 project.json：general.properties 有 mode=1、无 op（${JSON.stringify(propsV).slice(0, 90)}）`);
  var errsV = await h.errorLines();
  check(errsV.filter((l) => !/alpha' 失败/.test(l)).length === 0, `用户属性流程无错误${errsV.length ? `：${errsV.slice(0, 2).join(" / ")}` : ""}`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedV[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpV = await ev(`({ w: innerWidth, h: innerHeight })`);
  var bV = await pixelAt(worldToPage({ x: 0, y: 0, w: vpV.w, h: vpV.h }, [1110, 590]));
  check(close(bV, editorV, 12), `测试台：按存盘属性值出帧，与编辑器一致（测试台 ${bV} / 编辑器 ${editorV}）`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("V", "V. 用户属性端到端（声明 → 绑定 → 拖值热更 → 撤销 → combo 显隐 → 删除解绑 → 存库 → 测试台）", err); }
  section("W. 外来脚本拦截（W10 过渡：在线版默认不执行，逐文档放行）");
  if (hlState.dead) hlSkip("W", "W. 外来脚本拦截（W10 过渡：在线版默认不执行，逐文档放行）"); else try {
  var firstFrame = `${"/首帧就绪|First frame ready/"}.test(document.querySelector('#ed-con-body').textContent)`;
  var bannerOn = () => ev(`!document.querySelector('#ed-scripts-off').hidden`);
  // U 段存进库的条目：stripe 的 alpha 脚本 `return 0.5`
  await reopen(savedU[0], "?scripts=off");
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(firstFrame, 90000);
  await settle();
  var crW = await h.canvasRect();
  var wTop = worldToPage(crW, [1110, 590]);
  var blocked = await pixelAt(wTop);
  check(isRed(blocked), `?scripts=off 打开带脚本的库条目：脚本不执行，alpha 停在快照 1（实得 ${blocked}）`);
  // 拦截提示与诊断流是在首帧之后异步补上的：等一会儿再断言（超时就按当时的实际值报红）
  await waitFor(`!document.querySelector('#ed-scripts-off').hidden && /1/.test(document.querySelector('#ed-scripts-off-text').textContent)`, 8000).catch(() => {});
  check((await bannerOn()) && /1/.test(await ev(`document.querySelector('#ed-scripts-off-text').textContent`)), `视口底部提示「已拦截 1 段脚本」并给「仍然执行」（实得「${(await ev(`document.querySelector('#ed-scripts-off-text').textContent`)).trim()}」，提示${(await bannerOn()) ? "在" : "不在"}）`);
  await waitFor(`document.querySelector('#ed-con-body').textContent.includes('scripts disabled: skipped 1')`, 8000).catch(() => {});
  check((await ev(`document.querySelector('#ed-con-body').textContent`)).includes("scripts disabled: skipped 1"), `诊断流记一条拦截计数（实得 ${JSON.stringify((await ev(`document.querySelector('#ed-con-body').textContent`)).split("\n").filter((l) => /script/i.test(l)).slice(-2).join(" | "))}）`);
  var rAllow = await h.readyCount();
  await clickSel("#scripts-allow");
  await h.waitRemount(rAllow);
  await settle();
  var allowed = await pixelAt(wTop);
  check(close(allowed, half, 14) && !(await bannerOn()), `「仍然执行」：原地重挂，脚本生效（半透明 ${allowed}），提示收起`);

  await reopen(savedU[0]);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(firstFrame, 90000);
  await settle();
  check(close(await pixelAt(worldToPage(await h.canvasRect(), [1110, 590])), half, 14) && !(await bannerOn()), "dev 宿主默认（无覆盖）：照常执行，无提示");

  await gotoEditor(`?scripts=off`);
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor(`?scripts=off`);
  await newBlank("#202020");
  await addImage(stripePath);
  await fxAct(`const s = document.querySelector('#script-add'); s.value = 'alpha'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
  await scType("alpha", "export function update(value) {\n\treturn 0;\n}\n");
  await scApply("alpha");
  await settle();
  var crW2 = await h.canvasRect();
  check(close(await pixelAt(worldToPage(crW2, [1110, 590])), BGV, 10) && !(await bannerOn()), "安全模式下新建的工程：用户自己写的脚本照常执行");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("W", "W. 外来脚本拦截（W10 过渡：在线版默认不执行，逐文档放行）", err); }
  section("X. 导出 WE 原生 scene.pkg（空白 → 图片层 + 效果 → 勾选原生格式存库 → 测试台 / 重新打开出帧一致）");
  if (hlState.dead) hlSkip("X", "X. 导出 WE 原生 scene.pkg（空白 → 图片层 + 效果 → 勾选原生格式存库 → 测试台 / 重新打开出帧一致）"); else try {
  var { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
  var { parseTex, decodeMip0 } = await imp("renderer/vendor/we-scene/pkg/texture.js");
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#000000");
  await addImage(stripePath);
  await fxAdd("tint");
  await settle();
  var crX = await h.canvasRect();
  var xTop = await pixelAt(worldToPage(crX, [1110, 590]));
  var xBot = await pixelAt(worldToPage(crX, [1110, 490]));
  check(close(xTop, tintWant, 6), `编辑器：红色图层叠上缺省橙色 50%（期望 ${tintWant}，实得 ${xTop}）`);

  var idX = await saveLoose();
  var dirLoose = path.join(lib, idX);
  check(fs.existsSync(path.join(dirLoose, "scene.json")) && fs.existsSync(path.join(dirLoose, "materials/editor/stripe.png")) && !fs.existsSync(path.join(dirLoose, "scene.pkg")), "项目文件夹保持松散文件，不含 scene.pkg");
  var pkgDl = await captureDownload(async () => {
    await clickSel("#tb-pack");
    await clickSel("#export-pkg");
  });
  check(/-pkg\.zip$/.test(pkgDl.name), `打包导出是 zip 下载（${pkgDl.name}）`);
  var pkgZip = path.join(tmpRoot, "e2e-pkg.zip");
  fs.writeFileSync(pkgZip, Buffer.from(pkgDl.base64, "base64"));
  var pkgOut = path.join(tmpRoot, "e2e-pkg-out");
  fs.rmSync(pkgOut, { recursive: true, force: true });
  fs.mkdirSync(pkgOut, { recursive: true });
  var uzX = spawnSync("unzip", ["-o", pkgZip, "-d", pkgOut], { encoding: "utf8" });
  check(uzX.status === 0, "打包 zip 能解开");
  var filesX = fs.readdirSync(pkgOut).filter((n) => !n.startsWith(".")).sort();
  check(JSON.stringify(filesX) === JSON.stringify(["preview.jpg", "project.json", "scene.pkg"]), `压缩包内 = project.json + scene.pkg + 封面，无散装资源（${JSON.stringify(filesX)}）`);
  var projX = JSON.parse(fs.readFileSync(path.join(pkgOut, "project.json"), "utf8"));
  check(projX.file === "scene.json" && projX.type === "scene", "project.json：file 指包内 scene.json");
  var pkX = parsePkg(new Uint8Array(fs.readFileSync(path.join(pkgOut, "scene.pkg"))));
  var namesX = pkX.entries.map((e) => e.name);
  check(namesX.includes("scene.json") && namesX.includes("materials/editor/stripe.tex") && !namesX.some((n) => /\.(png|jpe?g)$/i.test(n)) && namesX.includes("shaders/effects/wwgl_tint.frag"), `包内：入口 + .tex 贴图 + 效果四件，无源图（${namesX.length} 项）`);
  var texX = decodeMip0(parseTex(getEntry(pkX, "materials/editor/stripe.tex")));
  check(texX.png && Buffer.compare(Buffer.from(texX.png), fs.readFileSync(stripePath)) === 0 && texX.width === 400 && texX.height === 200, ".tex 内嵌的就是拖进来的 PNG 原字节（400×200，零重编码）");
  check(/已打包 scene\.pkg|Packed scene\.pkg/.test(await ev(`document.querySelector('#ed-con-body').textContent`)), "控制台记一条打包摘要");
  var errsX = await h.errorLines();
  check(errsX.length === 0, `导出全程无错误${errsX.length ? `：${errsX.slice(0, 2).join(" / ")}` : ""}`);

  var playId = "editor-e2e-pkgplay";
  fs.rmSync(path.join(lib, playId), { recursive: true, force: true });
  fs.cpSync(pkgOut, path.join(lib, playId), { recursive: true });
  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${playId}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpX = await ev(`({ w: innerWidth, h: innerHeight })`);
  var benchX = { x: 0, y: 0, w: vpX.w, h: vpX.h };
  var bTopX = await pixelAt(worldToPage(benchX, [1110, 590]));
  var bBotX = await pixelAt(worldToPage(benchX, [1110, 490]));
  check(close(bTopX, xTop, 12) && close(bBotX, xBot, 12), `★ 测试台按 scene.pkg 出帧，与编辑器一致（测试台 ${bTopX} / ${bBotX}，编辑器 ${xTop} / ${xBot}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/pkg-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/pkg-in-bench.jpg`);

  await gotoEditor();
  await ev(`(() => { window.__e2eMode = 'seed'; window.__e2eSeed = ${JSON.stringify({ base: `${origin}/media/dev/${playId}/`, paths: ["preview.jpg", "project.json", "scene.pkg"] })}; return true; })()`);
  await openLocal();
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(firstFrame, 90000);
  await settle();
  check(close(await pixelAt(worldToPage(await h.canvasRect(), [1110, 590])), xTop, 12), "编辑器重新打开导出的包条目：画面一致");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("X", "X. 导出 WE 原生 scene.pkg（空白 → 图片层 + 效果 → 勾选原生格式存库 → 测试台 / 重新打开出帧一致）", err); }
  section("Y. 文字层端到端（空白 → 文字 / 时钟层 → 改内容 / 字号 / 颜色 / 导入字体 → 撤销 → 存库 → 测试台出帧一致）");
  if (hlState.dead) hlSkip("Y", "Y. 文字层端到端（空白 → 文字 / 时钟层 → 改内容 / 字号 / 颜色 / 导入字体 → 撤销 → 存库 → 测试台出帧一致）"); else try {
  /** 页面矩形内的墨水：亮像素占比 + 亮像素平均色（黑底） */
  var inkIn = async ([x0, y0], [x1, y1], thr = 200) => {
    const clip = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(2, Math.abs(x1 - x0)), height: Math.max(2, Math.abs(y1 - y0)), scale: 1 };
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip });
    return ev(`(async () => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data; let n = 0; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { if (d[i] + d[i + 1] + d[i + 2] > ${thr}) { n++; s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; } }
      return { frac: n / (d.length / 4), color: n ? s.map((v) => Math.round(v / n)) : [0, 0, 0] };
    })()`);
  };
  var worldBox = (cr, [cx, cy], [hw, hh]) => [worldToPage(cr, [cx - hw, cy + hh]), worldToPage(cr, [cx + hw, cy - hh])];
  var rawObj = () => ev(`JSON.parse(document.querySelector('.ed-insp-raw').textContent)`);
  var textAct = (js) => fxAct(js);
  var setText = (name, value) =>
    textAct(`const el = document.querySelector('.ed-text [data-text="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var addTextPreset = async (preset) => {
    const r0 = await h.readyCount();
    await clickSel("#ly-add-text");
    await clickSel(`#text-menu button[data-preset="${preset}"]`);
    await h.waitRemount(r0);
  };
  /** 页面里按引擎同一字体栈量宽度（Arial 系统字体） */
  var arialWidth = (s, px) => ev(`(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '${px}px Arial, \\'Helvetica Neue\\', sans-serif, sans-serif'; return c.measureText(${JSON.stringify(s)}).width; })()`);
  var sizeOf = (o) => String(o.size).split(/\s+/).map(Number);

  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  check(await ev(`document.querySelector('#ly-add-text').disabled`), "未打开场景时「添加文字层」不可用");
  await newBlank("#000000");
  check(!(await ev(`document.querySelector('#ly-add-text').disabled`)), "新建后「添加文字层」可用");
  await clickSel("#ly-add-text");
  check(await ev(`!document.querySelector('#text-menu').hidden && document.querySelectorAll('#text-menu button[data-preset]').length === 3`), "点开文字菜单：文字 / 时钟 / 日期三项");
  await clickSel("#ly-add-text");
  check(await ev(`document.querySelector('#text-menu').hidden`), "再点收起");

  await addTextPreset("plain");
  var plainName = (await h.treeNames())[0];
  check((await h.treeNames()).length === 1 && (await h.selectedName()) === plainName && /文字|Text/.test(plainName), `添加文字层：树里一层「${plainName}」并选中`);
  check(await ev(`!!document.querySelector('.ed-text') && !document.querySelector('.ed-text [data-text="content"]').readOnly`), "检视器有「文字」分组，内容可编辑");
  check(await ev(`document.querySelector('.ed-text [data-text="font"]').value === 'systemfont_arial' && document.querySelector('.ed-text [data-text="size"]').value === '32'`), "缺省字体 Arial、字号 32");

  await setText("content", "MMM");
  var o = await rawObj();
  var wantW = await arialWidth("MMM", 128);
  check(o.text === "MMM" && Math.abs(sizeOf(o)[0] - wantW) < 0.01 && Math.abs(sizeOf(o)[1] - 153.6) < 0.01, `改内容后盒按页面实测宽度回填（size ${o.size}，Arial 实测 ${wantW.toFixed(3)}）`);
  await setText("size", "60");
  o = await rawObj();
  check(o.pointsize === 60 && Math.abs(sizeOf(o)[1] - 288) < 0.01 && Math.abs(sizeOf(o)[0] - (await arialWidth("MMM", 240))) < 0.01, `改字号 60：盒跟着重量（${o.size}）`);
  await h.setInputs({ 0: 960, 1: 800 });
  await settle();
  var crY = await h.canvasRect();
  var boxW = sizeOf(o)[0] / 2;
  var ink = await inkIn(...worldBox(crY, [960, 800], [boxW, 110]));
  check(ink.frac > 0.12 && ink.color.every((c) => c > 200), `画面真画出白色文字（墨水占比 ${ink.frac.toFixed(3)}，色 ${ink.color}）`);
  check((await inkIn(...worldBox(crY, [960, 540], [boxW, 110]))).frac < 0.01, "挪到 y=800 后原位置没有残影");

  await ev(`(() => { ${REVEAL} const c = reveal(document.querySelector('#ed-inspector fieldset.ed-form input[type=color]')); c.focus(); c.value = '#ff0000'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); c.blur(); return true; })()`);
  await settle();
  ink = await inkIn(...worldBox(crY, [960, 800], [boxW, 110]));
  check(ink.frac > 0.12 && ink.color[0] > 200 && ink.color[1] < 60 && ink.color[2] < 60, `颜色改红：文字变红（${ink.color}）`);

  await setText("halign", "right");
  o = await rawObj();
  check(o.horizontalalign === "right" && (await ev(`document.querySelector('.ed-text [data-text="halign"]').value`)) === "right", "水平对齐改右：文档与控件一致");
  await setText("halign", "center");

  var fontPath = "/System/Library/Fonts/Supplemental/Arial Black.ttf";
  if (fs.existsSync(fontPath)) {
    const wBefore = sizeOf(await rawObj())[0];
    const r0 = await h.readyCount();
    await ev(`(() => { const s = document.querySelector('.ed-text [data-text="font"]'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await setFiles("#in-font", [fontPath]);
    await h.waitRemount(r0);
    o = await rawObj();
    check(o.font === "fonts/arial-black.ttf", `导入字体：字体字段指向工程内 fonts/arial-black.ttf（${o.font}）`);
    check(sizeOf(o)[0] > wBefore * 1.1, `页面装上导入的字体再量盒：Arial Black 更宽（${wBefore.toFixed(1)} → ${sizeOf(o)[0].toFixed(1)}）`);
    check(await ev(`(() => { const s = document.querySelector('.ed-text [data-text="font"]'); return s.value === 'fonts/arial-black.ttf' && [...s.querySelectorAll('optgroup')].length === 2; })()`), "字体下拉：选中导入的字体，分「系统 / 工程」两组");
    check(/fonts\/arial-black\.ttf/.test(await ev(`document.querySelector('#ed-con-body').textContent`)), "控制台记一条导入字体");
  } else {
    console.log("  （本机没有 Arial Black.ttf，跳过导入字体）");
  }

  await addTextPreset("clock");
  var names = await h.treeNames();
  check(names.length === 2 && /时钟|Clock/.test(names[1]) && (await h.selectedName()) === names[1], `添加时钟层：第二层「${names[1]}」并选中`);
  check(await ev(`document.querySelector('.ed-text [data-text="content"]').readOnly && !!document.querySelector('.ed-script[data-target="text"]')`), "时钟内容只读，脚本分组里有 text 脚本");
  await settle();
  var clockInk = await inkIn(...worldBox(crY, [960, 540], [300, 70]));
  check(clockInk.frac > 0.05, `时钟在画面中心画出时间（墨水占比 ${clockInk.frac.toFixed(3)}）`);
  check(await ev(`(() => { const L = document.querySelector('#ed-con-body').textContent; return !/脚本.*错误|script.*error/i.test(L); })()`), "时钟脚本运行无错误");

  var r1 = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(r1);
  check((await h.treeNames()).length === 1, "撤销添加时钟：回到一层");
  r1 = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(r1);
  check((await h.treeNames()).length === 2, "重做：时钟回来");

  var savedY = [await saveLoose()];
  var dirY = path.join(lib, savedY[0]);
  var sceneY = JSON.parse(fs.readFileSync(path.join(dirY, "scene.json"), "utf8"));
  var [tPlain, tClock] = sceneY.objects;
  var plainColor = String(tPlain.color).trim().split(/\s+/).map(Number);
  check(sceneY.objects.length === 2 && tPlain.text === "MMM" && tPlain.pointsize === 60 && close(plainColor, [1, 0, 0], 1e-3), `盘上 scene.json：文字层内容 / 字号 / 颜色（${JSON.stringify({ text: tPlain.text, pointsize: tPlain.pointsize, color: tPlain.color })}）`);
  check(typeof tClock.text === "object" && /getHours/.test(tClock.text.script) && tClock.text.scriptproperties?.use24h === true, "盘上时钟层：{ script, scriptproperties, value } 原样");
  if (fs.existsSync(fontPath)) {
    check(fs.existsSync(path.join(dirY, "fonts/arial-black.ttf")) && Buffer.compare(fs.readFileSync(path.join(dirY, "fonts/arial-black.ttf")), fs.readFileSync(fontPath)) === 0, "盘上字体文件逐字节原样");
  }
  var errsY = await h.errorLines();
  check(errsY.length === 0, `文字层编辑全程无错误${errsY.length ? `：${errsY.slice(0, 2).join(" / ")}` : ""}`);

  await reopen(savedY[0]);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(firstFrame, 90000);
  await new Promise((r) => setTimeout(r, 800));
  var crY2 = await h.canvasRect();
  var edPlain = await inkIn(...worldBox(crY2, [960, 800], [boxW * 1.4, 110]));
  check(edPlain.frac > 0.12 && edPlain.color[0] > 200 && edPlain.color[1] < 60, `编辑器重新打开：红字在原位（${edPlain.frac.toFixed(3)} / ${edPlain.color}）`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedY[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpY = await ev(`({ w: innerWidth, h: innerHeight })`);
  var benchY = { x: 0, y: 0, w: vpY.w, h: vpY.h };
  var bPlain = await inkIn(...worldBox(benchY, [960, 800], [boxW * 1.4, 110]));
  var bClock = await inkIn(...worldBox(benchY, [960, 540], [300, 70]));
  check(Math.abs(bPlain.frac - edPlain.frac) < 0.04 && close(bPlain.color, edPlain.color, 25), `★ 测试台文字出帧与编辑器一致（墨水 ${bPlain.frac.toFixed(3)} vs ${edPlain.frac.toFixed(3)}，色 ${bPlain.color} vs ${edPlain.color}）`);
  check(bClock.frac > 0.05, `★ 测试台时钟层画出时间（墨水占比 ${bClock.frac.toFixed(3)}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/text-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/text-in-bench.jpg`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("Y", "Y. 文字层端到端（空白 → 文字 / 时钟层 → 改内容 / 字号 / 颜色 / 导入字体 → 撤销 → 存库 → 测试台出帧一致）", err); }
  section("Z. 粒子层端到端（空白 → 雪 → 调数量 / 颜色 → 撤销 → 火花 → 存库 → 测试台出帧）");
  if (hlState.dead) hlSkip("Z", "Z. 粒子层端到端（空白 → 雪 → 调数量 / 颜色 → 撤销 → 火花 → 存库 → 测试台出帧）"); else try {
  var ptSet = (name, value) =>
    fxAct(`const el = document.querySelector('.ed-particle [data-particle="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var ptCheck = (name, on) =>
    fxAct(`const el = document.querySelector('.ed-particle [data-particle="${name}"]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var addParticlePreset = async (preset) => {
    const r0 = await h.readyCount();
    await clickSel("#ly-add-particle");
    await clickSel(`#particle-menu button[data-preset="${preset}"]`);
    await h.waitRemount(r0);
  };
  /** 整个画面的墨水（粒子随机，取全屏统计；halo 边缘很软，门槛放低） */
  var fullInk = async (cr) => {
    await new Promise((r) => setTimeout(r, 900));
    return inkIn(...worldBox(cr, [960, 540], [956, 536]), 60);
  };
  var whitish = (c) => Math.min(...c) > 40 && Math.max(...c) - Math.min(...c) < 25;
  var reddish = (c) => c[0] > 80 && c[0] > 2 * c[1] && c[0] > 2 * c[2];

  await gotoEditor();
  check(await ev(`document.querySelector('#ly-add-particle').disabled`), "未打开场景时「添加粒子层」不可用");
  await newBlank("#000000");
  check(!(await ev(`document.querySelector('#ly-add-particle').disabled`)), "新建后「添加粒子层」可用");
  await clickSel("#ly-add-particle");
  // examples/plugins/particle-fireflies 会多贡献一个预设 ⇒ 断言四个内置预设都在，不锁死总数。
  var presetVals = await ev(`[...document.querySelectorAll('#particle-menu button[data-preset]')].map((b) => b.dataset.preset)`);
  check(
    (await ev(`!document.querySelector('#particle-menu').hidden`)) && BUILTIN_PRESETS.every((p) => presetVals.includes(p)),
    `点开粒子菜单：雪 / 雨 / 火花 / 光点四项（实得 ${presetVals.length} 项：${presetVals.join(",")}）`,
  );
  await clickSel("#ly-add-text");
  check(await ev(`document.querySelector('#particle-menu').hidden && !document.querySelector('#text-menu').hidden`), "点文字按钮：粒子菜单收起、文字菜单打开（同时只开一个）");
  await clickSel("#ly-add-text");

  await addParticlePreset("snow");
  var snowName = (await h.treeNames())[0];
  check((await h.treeNames()).length === 1 && (await h.selectedName()) === snowName && /雪|Snow/.test(snowName), `添加雪：树里一层「${snowName}」并选中`);
  check(await ev(`document.querySelectorAll('.ed-particle input[type=range][data-particle]').length === 6 && !!document.querySelector('.ed-particle [data-particle="color"]')`), "检视器有「粒子」分组：6 个倍率滑条 + 颜色");
  check(await ev(`!document.querySelector('.ed-particle [data-particle="colorOn"]').checked && document.querySelector('.ed-particle [data-particle="color"]').disabled`), "缺省不覆盖颜色（颜色框灰掉）");
  var po = await rawObj();
  check(po.particle === "particles/editor/snow.json" && po.instanceoverride?.count === 1, "文档：particle 指向 particles/editor/snow.json，倍率初始 1");
  var crZ = await h.canvasRect();
  var snowInk = await fullInk(crZ);
  check(snowInk.frac > 0.002 && whitish(snowInk.color), `画面真画出白色雪花（墨水占比 ${snowInk.frac.toFixed(4)}，色 ${snowInk.color}）`);

  await ptSet("count", "0");
  po = await rawObj();
  var noneInk = await fullInk(crZ);
  check(po.instanceoverride.count === 0 && noneInk.frac < snowInk.frac * 0.2, `数量拖到 0：instanceoverride.count = 0，画面几乎没有雪（${noneInk.frac.toFixed(4)}）`);
  var rz = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rz);
  po = await rawObj();
  var backInk = await fullInk(crZ);
  check(po.instanceoverride.count === 1 && backInk.frac > snowInk.frac * 0.5, `撤销：数量回到 1，雪回来（${backInk.frac.toFixed(4)}）`);

  await ptSet("size", "3");
  await ptCheck("colorOn", true);
  await ptSet("color", "#ff0000");
  po = await rawObj();
  check(po.instanceoverride.size === 3 && po.instanceoverride.colorn === "1.000 0.000 0.000", `大小 3 + 颜色覆盖红：instanceoverride ${JSON.stringify(po.instanceoverride)}`);
  check(await ev(`document.querySelector('.ed-particle [data-particle="colorOn"]').checked && document.querySelector('.ed-particle [data-particle="color"]').value === '#ff0000'`), "检视器重绘后控件与文档一致");
  var redInk = await fullInk(crZ);
  check(redInk.frac > snowInk.frac * 1.5 && reddish(redInk.color), `画面：雪花变大变红（墨水 ${redInk.frac.toFixed(4)}，色 ${redInk.color}）`);

  await addParticlePreset("embers");
  var namesZ = await h.treeNames();
  check(namesZ.length === 2 && /火花|Embers/.test(namesZ[1]), `添加火花：第二层「${namesZ[1]}」`);
  var errsZ = await h.errorLines();
  check(errsZ.length === 0, `粒子层编辑全程无错误${errsZ.length ? `：${errsZ.slice(0, 2).join(" / ")}` : ""}`);

  var savedZ = [await saveLoose()];
  var dirZ = path.join(lib, savedZ[0]);
  var sceneZ = JSON.parse(fs.readFileSync(path.join(dirZ, "scene.json"), "utf8"));
  var [zSnow, zEmbers] = sceneZ.objects;
  check(sceneZ.objects.length === 2 && zSnow.instanceoverride?.colorn === "1.000 0.000 0.000" && zSnow.instanceoverride?.size === 3 && zEmbers.particle === "particles/editor/embers.json", "盘上 scene.json：雪的调参与火花层");
  var onDisk = ["particles/editor/snow.json", "materials/editor/particles/snow.json", "particles/editor/embers.json", "materials/editor/particles/embers.json"];
  check(onDisk.every((f) => fs.existsSync(path.join(dirZ, f))), "盘上两层各自的粒子 / 材质文件都在");
  check(JSON.parse(fs.readFileSync(path.join(dirZ, "materials/editor/particles/embers.json"), "utf8")).passes[0].textures[0] === "particle/halo" && !fs.existsSync(path.join(dirZ, "materials/particle")), "材质只引用内置名，没有拷贝贴图文件");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedZ[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  var vpZ = await ev(`({ w: innerWidth, h: innerHeight })`);
  var benchZ = await inkIn(...worldBox({ x: 0, y: 0, w: vpZ.w, h: vpZ.h }, [960, 540], [956, 536]), 60);
  var top = await inkIn(...worldBox({ x: 0, y: 0, w: vpZ.w, h: vpZ.h }, [960, 800], [956, 270]), 60);
  check(benchZ.frac > snowInk.frac && top.color[0] > 80 && top.color[0] > top.color[2] + 30, `★ 测试台出帧：红色大雪花 + 火花（墨水 ${benchZ.frac.toFixed(4)}，上半屏色 ${top.color}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/particles-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/particles-in-bench.jpg`);

  } catch (err) { await hlAbort("Z", "Z. 粒子层端到端（空白 → 雪 → 调数量 / 颜色 → 撤销 → 火花 → 存库 → 测试台出帧）", err); }
  section("AA. 声音层端到端（空白 → 导入 WAV → 试听 → 音量 / 模式 / 开始静音 → 撤销 → 替换 → 存库 → 测试台装上音频）");
  if (hlState.dead) hlSkip("AA", "AA. 声音层端到端（空白 → 导入 WAV → 试听 → 音量 / 模式 / 开始静音 → 撤销 → 替换 → 存库 → 测试台装上音频）"); else try {
  var wavBytes = (sec, freq, rate = 8000) => {
    const n = Math.round(sec * rate);
    const b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
    b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
    b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), 44 + i * 2);
    return b;
  };
  var rainWav = path.join(tmpRoot, "rain.wav");
  var birdWav = path.join(tmpRoot, "bird.wav");
  fs.writeFileSync(rainWav, wavBytes(1.5, 330));
  fs.writeFileSync(birdWav, wavBytes(0.8, 880));
  var sndSet = (name, value) =>
    fxAct(`const el = document.querySelector('.ed-sound [data-sound="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var sndCheck = (name, on) =>
    fxAct(`const el = document.querySelector('.ed-sound [data-sound="${name}"]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var playing = () => ev(`document.querySelector('.ed-sound [data-sound="preview"]')?.dataset.playing`);

  await gotoEditor();
  check(await ev(`document.querySelector('#ly-add-sound').disabled`), "未打开场景时「添加声音层」不可用");
  await newBlank("#000000");
  check(!(await ev(`document.querySelector('#ly-add-sound').disabled`)), "新建后「添加声音层」可用");
  var rs = await h.readyCount();
  await clickSel("#ly-add-sound");
  await setFiles("#in-sound", [rainWav]);
  await h.waitRemount(rs);
  check((await h.treeNames()).length === 1 && (await h.selectedName()) === "rain", `导入 rain.wav：树里一层「${await h.selectedName()}」并选中`);
  check(await ev(`!!document.querySelector('.ed-sound') && document.querySelector('.ed-sound [data-sound="playbackmode"]').value === 'loop' && document.querySelector('.ed-sound [data-sound="volume"]').value === '1' && !document.querySelector('.ed-sound [data-sound="startsilent"]').checked && document.querySelector('.ed-snd-file').textContent === 'rain.wav'`), "检视器有「声音」分组：文件名、循环、音量 1、不静音开始");
  check(await ev(`!!document.querySelector('.ed-bindings')`), "声音层也有「属性绑定」分组（音量可绑用户滑条，离线单测覆盖绑定本身）");
  var so = await rawObj();
  check(so.sound?.[0] === "sounds/rain.wav" && so.playbackmode === "loop" && so.volume === 1 && so.startsilent === false, `文档：${JSON.stringify({ sound: so.sound, playbackmode: so.playbackmode, volume: so.volume })}`);

  await clickSel('.ed-sound [data-sound="preview"]');
  await waitFor(`document.querySelector('.ed-sound [data-sound="preview"]').dataset.playing === '1'`, 8000).catch(() => {});
  check((await playing()) === "1", "点「试听」：按钮进入播放态");
  await clickSel('.ed-sound [data-sound="preview"]');
  check((await playing()) === "0", "再点：停止试听");

  await sndSet("volume", "0.5");
  await sndSet("playbackmode", "single");
  await sndCheck("startsilent", true);
  so = await rawObj();
  check(so.volume === 0.5 && so.playbackmode === "single" && so.startsilent === true, `音量 0.5 / 单次 / 开始静音写进文档：${JSON.stringify({ volume: so.volume, playbackmode: so.playbackmode, startsilent: so.startsilent })}`);
  check(await ev(`document.querySelector('.ed-sound [data-sound="volume"]').value === '0.5' && document.querySelector('.ed-sound [data-sound="playbackmode"]').value === 'single' && document.querySelector('.ed-sound [data-sound="startsilent"]').checked`), "检视器重绘后控件与文档一致");
  rs = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rs);
  so = await rawObj();
  check(so.startsilent === false && so.playbackmode === "single", "撤销：开始静音撤回，模式仍是单次");
  rs = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(rs);
  so = await rawObj();
  check(so.startsilent === true, "重做：开始静音回来");
  await sndSet("playbackmode", "loop");

  rs = await h.readyCount();
  await clickSel('.ed-sound [data-sound="replace"]');
  await setFiles("#in-sound", [birdWav]);
  await h.waitRemount(rs);
  so = await rawObj();
  check((await h.treeNames()).length === 1 && so.sound?.[0] === "sounds/bird.wav" && so.volume === 0.5, `替换音频：仍一层，sound → ${so.sound?.[0]}，音量保留`);
  var errsAA = await h.errorLines();
  check(errsAA.length === 0, `声音层编辑全程无错误${errsAA.length ? `：${errsAA.slice(0, 2).join(" / ")}` : ""}`);

  var savedAA = [await saveLoose()];
  var dirAA = path.join(lib, savedAA[0]);
  var sceneAA = JSON.parse(fs.readFileSync(path.join(dirAA, "scene.json"), "utf8"));
  var sAA = sceneAA.objects[0];
  check(sceneAA.objects.length === 1 && sAA.sound?.[0] === "sounds/bird.wav" && sAA.volume === 0.5 && sAA.playbackmode === "loop" && sAA.startsilent === true, "盘上 scene.json：声音层字段齐全");
  var birdOnDisk = path.join(dirAA, "sounds/bird.wav");
  check(fs.existsSync(birdOnDisk) && Buffer.compare(fs.readFileSync(birdOnDisk), fs.readFileSync(birdWav)) === 0, "盘上 sounds/bird.wav 与导入的原文件逐字节相同");
  check(!fs.existsSync(path.join(dirAA, "sounds/rain.wav")), "被替换掉的 rain.wav 不再引用，不写盘");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedAA[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.some((l) => l.soundCtl)`, 90000);
  var benchAA = await ev(`(() => { const l = window.__sceneLayers.find((x) => x.soundCtl); return { vol: l.soundCtl.getVolume(), playing: l.soundCtl.isPlaying(), mode: l.soundprops?.playbackmode, silent: !!l.soundprops?.startsilent }; })()`);
  check(Math.abs(benchAA.vol - 0.5) < 1e-6 && benchAA.mode === "loop" && benchAA.silent && !benchAA.playing, `★ 测试台装上声音层：音量 ${benchAA.vol}、模式 ${benchAA.mode}、开始静音 → 未自动播放`);
  await click([20, 20]);
  var auAA = await ev(`(async () => {
    const orig = HTMLMediaElement.prototype.play;
    let el = null, res = null;
    HTMLMediaElement.prototype.play = function () { el = this; const p = orig.call(this); p.then(() => (res = 'ok'), (e) => (res = e.name)); return p; };
    window.__sceneLayers.find((x) => x.soundCtl).soundCtl.play();
    for (let i = 0; i < 40 && !res; i++) await new Promise((r) => setTimeout(r, 100));
    HTMLMediaElement.prototype.play = orig;
    return { res, playing: window.__sceneLayers.find((x) => x.soundCtl).soundCtl.isPlaying(), rs: el?.readyState, dur: el?.duration, loop: el?.loop };
  })()`);
  check(auAA.res === "ok" && auAA.playing && auAA.rs >= 2 && Math.abs(auAA.dur - 0.8) < 0.05 && auAA.loop, `★ 脚本侧 play() 后真的在播：解码出 ${auAA.dur?.toFixed(2)}s（bird.wav），循环 ${auAA.loop}，结果 ${auAA.res}`);

  } catch (err) { await hlAbort("AA", "AA. 声音层端到端（空白 → 导入 WAV → 试听 → 音量 / 模式 / 开始静音 → 撤销 → 替换 → 存库 → 测试台装上音频）", err); }
  section("AB. 关键帧动画端到端（文字层 → 开位置动画 → 2s 处改 x 自动落关键帧 → 跳关键帧 → 1s 处拖拽 → 撤销 → 删帧 / 模式 / 时长 / 插值 → 存库 → 测试台在动）");
  if (hlState.dead) hlSkip("AB", "AB. 关键帧动画端到端（文字层 → 开位置动画 → 2s 处改 x 自动落关键帧 → 跳关键帧 → 1s 处拖拽 → 撤销 → 删帧 / 模式 / 时长 / 插值 → 存库 → 测试台在动）"); else try {
  var animOn = (f, on) =>
    fxAct(`const el = document.querySelector('.ed-anim [data-anim-on="${f}"]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var animSet = (attr, f, value) =>
    fxAct(`const el = document.querySelector('.ed-anim [data-anim-${attr}="${f}"]'); ${typeof value === "boolean" ? `el.checked = ${value}` : `el.value = ${JSON.stringify(value)}`}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  var seekTo = async (t) => {
    await ev(`(() => { const r = document.querySelector('#tl-range'); r.value = '${t}'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle();
  };
  var json = JSON.stringify;
  var keysOf = (o, c = 0) => o.origin.animation[`c${c}`].map((k) => [k.frame, Math.round(k.value * 100) / 100]);

  await gotoEditor();
  await newBlank("#000000");
  await addTextPreset("plain");
  await setText("content", "MMM");
  await setText("size", "60");
  var ao = await rawObj();
  var abW = sizeOf(ao)[0] / 2;
  var origin0 = ao.origin;
  // 开关集合就是 editor/keyframes.ts 的 ANIM_FIELDS（M4 起 brightness 也是可关键帧字段，共六个）
  check(await ev(`(() => { const on = [...document.querySelectorAll('.ed-anim [data-anim-on]')]; return on.length === 6 && on.map((c) => c.dataset.animOn).join() === 'origin,scale,angles,alpha,color,brightness' && on.every((c) => !c.checked); })()`), "检视器有「动画」分组：位置 / 缩放 / 旋转 / 不透明度 / 颜色 / 亮度六个开关，缺省全关");
  if (await ev(`document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`)) await clickSel("#tb-play");
  await seekTo(0);

  await animOn("origin", true);
  ao = await rawObj();
  check(ao.origin.value === origin0 && json(keysOf(ao)) === json([[0, 960]]) && ao.origin.animation.options.mode === "loop", `开位置动画：第 0 帧关键帧 = 当前值，静态值保留（${json(keysOf(ao))}）`);
  check(await ev(`!!document.querySelector('.ed-anim [data-anim-key="origin"]') && document.querySelectorAll('.ed-anim-keys[data-field="origin"] .ed-anim-key').length === 1`), "出现「◆ 关键帧」按钮与关键帧列表");

  await seekTo(2);
  var ra = await h.readyCount();
  await h.setInputs({ 0: 1260 });
  await h.waitRemount(ra);
  ao = await rawObj();
  check(json(keysOf(ao)) === json([[0, 960], [60, 1260]]) && ao.origin.value === origin0, `★ 2s 处改 x = 1260：自动落第 60 帧关键帧，静态值不动（${json(keysOf(ao))}）`);
  check(Math.abs((await h.numInputs())[0] - 1260) < 0.5 && (await ev(`document.querySelector('#tl-time').textContent`)) === "2.00s", "重挂后仍停在 2s，检视器显示该时刻的值");
  check((await ev(`document.querySelectorAll('#tl-keys .tl-key').length`)) === 2, "时间轴上两枚关键帧标记");
  var crA = await h.canvasRect();
  var inkR = await inkIn(...worldBox(crA, [1260, 540], [abW, 110]));
  var inkL = await inkIn(...worldBox(crA, [830, 540], [110, 110]));
  check(inkR.frac > 0.1 && inkL.frac < 0.02, `画面：2s 时文字在 x=1260（右框墨水 ${inkR.frac.toFixed(3)}，原位左半 ${inkL.frac.toFixed(3)}）`);

  var inspTabs = () => ev(`(() => { const tabs = [...document.querySelectorAll('#ed-inspector .ed-insp-tab')]; return { ids: tabs.map((b) => b.dataset.tab), active: tabs.filter((b) => b.getAttribute('aria-selected') === 'true').map((b) => b.dataset.tab), shown: [...document.querySelectorAll('#ed-inspector .ed-insp-panel')].filter((p) => !p.hidden).map((p) => p.dataset.tab), animIn: document.querySelector('.ed-anim')?.closest('.ed-insp-panel')?.dataset.tab, fxIn: document.querySelector('.ed-fx')?.closest('.ed-insp-panel')?.dataset.tab }; })()`);
  await clickSel('.ed-insp-tab[data-tab="props"]');
  var tb = await inspTabs();
  // examples/plugins/inspector-layer-stats 会贡献一个 "stats" 标签 ⇒ 只锁内置五个都在，额外标签放行。
  check(
    json(tb.active) === json(["props"]) &&
      json(tb.shown) === json(["props"]) &&
      tb.animIn === "anim" &&
      ["props", "anim", "fx", "logic", "info"].every((t) => tb.ids.includes(t)),
    `文字层检视器分标签：属性 / 动画 / 效果 / 逻辑 / 信息，只显示当前页（${json(tb)}）`,
  );
  await clickSel('.ed-anim-keys[data-field="origin"] button[data-frame="0"]');
  await settle();
  tb = await inspTabs();
  check(json(tb.active) === json(["anim"]) && json(tb.shown) === json(["anim"]), `点「动画」页里的关键帧：切到动画页（${json(tb)}）`);
  inkL = await inkIn(...worldBox(crA, [830, 540], [110, 110]));
  check(Math.abs((await h.numInputs())[0] - 960) < 0.5 && inkL.frac > 0.1, `点关键帧「0.00s」：跳回 0s，文字回到 x=960（墨水 ${inkL.frac.toFixed(3)}）`);

  await seekTo(1);
  var mid = await h.numInputs();
  check(Math.abs(mid[0] - 1110) < 1, `★ 往回 / 往前拖时间轴都按绝对时间定位：1s 时 x = ${mid[0]}（平滑插值的段中点 1110）`);
  ra = await h.readyCount();
  var from = worldToPage(crA, [1110, 540]);
  await drag(from, [from[0], from[1] - 60]);
  await h.waitRemount(ra);
  ao = await rawObj();
  var y30 = ao.origin.animation.c1.find((k) => k.frame === 30)?.value;
  check(json(keysOf(ao).map((k) => k[0])) === json([0, 30, 60]) && y30 > 560 && Math.abs(ao.origin.animation.c0[1].value - 1110) < 1, `★ 1s 处拖拽：落第 30 帧关键帧（x ${ao.origin.animation.c0[1].value}，y ${y30}）`);
  ra = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(ra);
  check((await rawObj()).origin.animation.c0.length === 2, "撤销：第 30 帧关键帧撤回");
  ra = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(ra);
  check((await rawObj()).origin.animation.c0.length === 3, "重做：回来");
  await fxAct(`document.querySelector('.ed-anim-keys[data-field="origin"] [data-key-del="30"]').click()`);
  check(json(keysOf(await rawObj()).map((k) => k[0])) === json([0, 60]), "× 删掉第 30 帧");

  } catch (err) { await hlAbort("AB", "AB. 关键帧动画端到端（文字层 → 开位置动画 → 2s 处改 x 自动落关键帧 → 跳关键帧 → 1s 处拖拽 → 撤销 → 删帧 / 模式 / 时长 / 插值 → 存库 → 测试台在动）", err); }
  section("AC. 关键帧补完（暂停时改动画字段画面跟手 → 时间轴拖关键帧改时刻 / 冲突拒绝 → 颜色动画）");
  if (hlState.dead) hlSkip("AC", "AC. 关键帧补完（暂停时改动画字段画面跟手 → 时间轴拖关键帧改时刻 / 冲突拒绝 → 颜色动画）"); else try {
  await seekTo(1);
  await ev(`(() => { ${REVEAL} const el = reveal(document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')[0]); el.focus(); el.value = '1500'; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await settle();
  inkR = await inkIn(...worldBox(crA, [1500, 540], [abW, 110]));
  inkL = await inkIn(...worldBox(crA, [830, 540], [110, 110]));
  check(inkR.frac > 0.1 && inkL.frac < 0.02, `★ 暂停在 1s 改动画层 x（只 input 未提交）：画面跟手到 1500，不被曲线拉回（新位置墨水 ${inkR.frac.toFixed(3)}，原位 ${inkL.frac.toFixed(3)}）`);
  ra = await h.readyCount();
  await ev(`(() => { const el = document.activeElement; el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return true; })()`);
  await h.waitRemount(ra);
  check(json(keysOf(await rawObj())) === json([[0, 960], [30, 1500], [60, 1260]]), "提交后落第 30 帧关键帧 x = 1500");

  var markAt = (t) =>
    ev(`(() => { const box = document.querySelector('#tl-keys').getBoundingClientRect(); const m = [...document.querySelectorAll('#tl-keys .tl-key')].find((e) => Math.abs(Number(e.dataset.t) - ${t}) < 1e-3); if (!m) return null; const r = m.getBoundingClientRect(); return { y: r.top + r.height / 2, x: r.left + r.width / 2, left: box.left, width: box.width, max: Number(document.querySelector('#tl-range').max), drag: m.classList.contains('is-draggable') }; })()`);
  var m1 = await markAt(1);
  check(!!m1 && m1.drag, "时间轴关键帧标记可拖（is-draggable）");
  var xOf = (mk, t) => mk.left + (t / mk.max) * mk.width;
  ra = await h.readyCount();
  await drag([m1.x, m1.y], [xOf(m1, 1.5), m1.y]);
  await h.waitRemount(ra);
  var fr = (await rawObj()).origin.animation.c0.map((k) => k.frame);
  check(fr.length === 3 && fr[0] === 0 && fr[2] === 60 && Math.abs(fr[1] - 45) <= 1 && (await rawObj()).origin.animation.c0[1].value === 1500, `★ 把 1s 的关键帧拖到 1.5s：帧号 ${json(fr)}，值不变`);
  var tMid = fr[1] / 30;
  var m2 = await markAt(tMid);
  var rb = await h.readyCount();
  await drag([m2.x, m2.y], [xOf(m2, 2), m2.y]);
  await settle();
  check((await h.readyCount()) === rb && json((await rawObj()).origin.animation.c0.map((k) => k.frame)) === json(fr) && (await ev(`document.querySelectorAll('#tl-keys .tl-key').length`)) === 3, "拖到已有关键帧的 2s：拒绝（不重挂、帧号不变、标记复原）");
  ra = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(ra);
  check(json((await rawObj()).origin.animation.c0.map((k) => k.frame)) === json([0, 30, 60]), "撤销：关键帧回到 1s");
  await fxAct(`document.querySelector('.ed-anim-keys[data-field="origin"] [data-key-del="30"]').click()`);
  check(json(keysOf(await rawObj()).map((k) => k[0])) === json([0, 60]), "删掉 1s 关键帧，回到两帧");

  await seekTo(0);
  await animOn("color", true);
  await seekTo(2);
  ra = await h.readyCount();
  await ev(`(() => { ${REVEAL} const el = reveal(document.querySelector('#ed-inspector fieldset.ed-form input[type=color]')); el.focus(); el.value = '#ff0000'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.blur(); return true; })()`);
  await h.waitRemount(ra);
  ao = await rawObj();
  check(ao.color?.animation?.c0?.length === 2 && ao.color.animation.c1.at(-1).frame === 60 && ao.color.animation.c1.at(-1).value === 0, `颜色开动画、2s 处改红：自动落第 60 帧颜色关键帧（${json(ao.color?.animation?.c1?.map((k) => [k.frame, k.value]))}）`);
  var inkRed = await inkIn(...worldBox(crA, [1260, 540], [abW, 110]));
  await seekTo(0);
  var inkWhite = await inkIn(...worldBox(crA, [960, 540], [abW, 110]));
  check(inkRed.color[0] > 180 && inkRed.color[1] < 80 && inkWhite.color.every((v) => v > 200), `★ 画面：2s 文字红 ${json(inkRed.color)}，0s 白 ${json(inkWhite.color)}（文字层颜色曲线真的写到绘制色）`);
  await seekTo(1);
  var inkPink = await inkIn(...worldBox(crA, [1110, 540], [abW, 110]), 120);
  check(inkPink.color[0] > 180 && inkPink.color[1] > 60 && inkPink.color[1] < 200, `1s 颜色在白与红之间（${json(inkPink.color)}）`);

  await animSet("mode", "origin", "mirror");
  await animSet("length", "origin", "4");
  await animSet("smooth", "origin", false);
  ao = await rawObj();
  check(ao.origin.animation.options.mode === "mirror" && ao.origin.animation.options.length === 120 && ao.origin.animation.c0.every((k) => !k.front.enabled && !k.back.enabled), `模式往返 / 时长 4s（120 帧）/ 线性：${json(ao.origin.animation.options)}`);
  var lenBefore = (await h.readyCount());
  await ev(`(() => { const el = document.querySelector('.ed-anim [data-anim-length="origin"]'); el.value = '1'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await settle();
  check((await h.readyCount()) === lenBefore && (await ev(`document.querySelector('.ed-anim [data-anim-length="origin"]').value`)) === "4" && (await rawObj()).origin.animation.options.length === 120, "时长短于最后关键帧（2s）：拒绝并复原输入框");
  var errsAB = (await h.errorLines()).filter((l) => !/时长不能短于|shorter than the last/.test(l));
  check(errsAB.length === 0, `关键帧编辑全程无错误${errsAB.length ? `：${errsAB.slice(0, 2).join(" / ")}` : ""}`);

  var savedAB = [await saveLoose()];
  var oAB = JSON.parse(fs.readFileSync(path.join(lib, savedAB[0], "scene.json"), "utf8")).objects[0];
  check(json(oAB.origin.animation.options) === json({ fps: 30, length: 120, mode: "mirror", wraploop: false }) && json(keysOf(oAB)) === json([[0, 960], [60, 1260]]), "盘上 scene.json：WE 原生动画格式、关键帧齐全");
  check(oAB.color?.animation?.c0?.length === 2 && typeof oAB.color.value === "string", "盘上 scene.json：颜色动画也按 WE 格式落盘");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedAB[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.some((l) => l.animationsByField?.origin)`, 90000);
  var xs = [];
  for (let i = 0; i < 4; i++) {
    xs.push(await ev(`window.__sceneLayers.find((l) => l.animationsByField?.origin).localOrigin[0]`));
    await new Promise((r) => setTimeout(r, 400));
  }
  check(new Set(xs.map((x) => Math.round(x))).size >= 3 && xs.every((x) => x >= 959 && x <= 1261), `★ 测试台：文字沿关键帧来回移动（x 采样 ${xs.map((x) => x.toFixed(0)).join(" → ")}）`);

  } catch (err) { await hlAbort("AC", "AC. 关键帧补完（暂停时改动画字段画面跟手 → 时间轴拖关键帧改时刻 / 冲突拒绝 → 颜色动画）", err); }
  section("AD. 图层树拖拽改父级 / 成组 / 锁定写入文档（成组 → 移动组子层跟随 → 拖进组画面不动 → 拖出 → 成环拒绝 → 撤销 → 锁定 → 存库 → 重开）");
  if (hlState.dead) hlSkip("AD", "AD. 图层树拖拽改父级 / 成组 / 锁定写入文档（成组 → 移动组子层跟随 → 拖进组画面不动 → 拖出 → 成环拒绝 → 撤销 → 锁定 → 存库 → 重开）"); else try {
  var rowAt = (id, f = 0.5) =>
    ev(`(() => { const n = document.querySelector('#ed-tree .ed-node[data-id="${id}"]'); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + 60, r.top + r.height * ${f}]; })()`);
  var depthOf = () => ev(`Object.fromEntries([...document.querySelectorAll('#ed-tree .ed-node')].map((n) => [n.dataset.id, (parseInt(n.style.paddingLeft) - 6) / 14]))`);
  var treeIds = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node')].map((n) => n.dataset.id)`);
  var clickRow = async (id) => {
    await click(await rowAt(id));
    await settle();
  };
  var dragRow = async (id, targetId, f) => {
    const r0 = await h.readyCount();
    await drag(await rowAt(id), await rowAt(targetId, f));
    return r0;
  };
  await gotoEditor();
  await newBlank("#000000");
  await addTextPreset("plain");
  await setText("content", "MMM");
  await setText("size", "60");
  var id1 = String((await rawObj()).id);
  await h.setInputs({ 0: 400 });
  await addTextPreset("plain");
  await setText("content", "WWW");
  await setText("size", "60");
  var id2 = String((await rawObj()).id);
  await h.setInputs({ 0: 1100 });
  await settle();
  var crD = await h.canvasRect();
  var inkX = async (x) => (await inkIn(...worldBox(crD, [x, 540], [50, 30]))).frac;
  check((await inkX(400)) > 0.05 && (await inkX(1100)) > 0.05 && (await ev(`document.querySelectorAll('#ed-tree .ed-node[data-id="${id1}"]').length === 1`)), `两个文字层（#${id1} 在 x=400，#${id2} 在 x=1100），树行带 data-id`);

  var rd = await h.readyCount();
  await clickSel("#ly-group");
  await h.waitRemount(rd);
  var gid = String((await rawObj()).id);
  var dep = await depthOf();
  check(gid !== id1 && gid !== id2 && dep[gid] === 0 && dep[id2] === 1 && json(await treeIds()) === json([id1, gid, id2]), `成组：新组 #${gid} 在原位，#${id2} 进组（树 ${json(await treeIds())}）`);
  check((await inkX(1100)) > 0.05 && (await ev(`document.querySelector('#ed-tree .ed-node[data-id="${gid}"] .ed-kind').dataset.kind`)) === "group", "成组后画面不变；行标「组」");
  await h.setInputs({ 0: 600 });
  await settle();
  check((await inkX(1700)) > 0.05 && (await inkX(1100)) < 0.01, "★ 移动组 x=600：组里的文字跟着到 1700（引擎父子合成生效）");

  rd = await dragRow(id1, gid, 0.5);
  await h.waitRemount(rd);
  dep = await depthOf();
  await clickRow(id1);
  check(dep[id1] === 1 && json(await treeIds()) === json([gid, id2, id1]) && Math.abs((await h.numInputs())[0] + 200) < 0.5, `★ 把 #${id1} 拖进组：成为最后一个子层，局部 x 改写为 -200（= 400 − 组的 600）`);
  var whiteX = async (x) => (await inkIn(...worldBox(crD, [x, 540], [50, 30]), 690)).frac;
  check((await whiteX(400)) > 0.05 && (await whiteX(1000)) < 0.01, "★ 画面上它仍在 x=400（没有被组平移到 1000；只数白字像素，避开选中描边）");

  rd = await dragRow(id1, gid, 0.1);
  await h.waitRemount(rd);
  dep = await depthOf();
  check(dep[id1] === 0 && json(await treeIds()) === json([id1, gid, id2]) && Math.abs((await h.numInputs())[0] - 400) < 0.5 && (await inkX(400)) > 0.05, "拖到组的上沿：回到根层排在组前，局部 x 回到 400，画面不动");

  rd = await dragRow(gid, id2, 0.5);
  await settle();
  check((await h.readyCount()) === rd && json(await treeIds()) === json([id1, gid, id2]) && (await ev(`[...document.querySelectorAll('#ed-con-body > div')].some((d) => /不能把|Cannot put/.test(d.textContent))`)), "把组拖进自己的子层：拒绝（不重挂、树不变、控制台提示）");

  rd = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rd);
  check((await depthOf())[id1] === 1, "撤销：回到组里");
  rd = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(rd);
  check((await depthOf())[id1] === 0, "重做：又拖出来");

  await clickRow(id1);
  await click(await h.rowButton((await ev(`document.querySelector('#ed-tree .ed-node[data-id="${id1}"] .ed-node-name').textContent`)), ".ed-lock"));
  await settle();
  check((await rawObj()).locktransforms === true && (await ev(`document.querySelector('#ed-tree .ed-node[data-id="${id1}"]').classList.contains('locked-layer')`)), "锁定：写进文档 locktransforms = true");
  rd = await dragRow(id1, gid, 0.5);
  await settle();
  check((await h.readyCount()) === rd && (await depthOf())[id1] === 0, "锁定的层拖不动");
  var errsAD = await h.errorLines();
  check(errsAD.length === 0, `图层树编辑全程无错误${errsAD.length ? `：${errsAD.slice(0, 2).join(" / ")}` : ""}`);

  var savedAD = [await saveLoose()];
  var objsAD = JSON.parse(fs.readFileSync(path.join(lib, savedAD[0], "scene.json"), "utf8")).objects;
  var by = (id) => objsAD.find((o) => String(o.id) === id);
  check(savedAD.length === 1 && by(id1).locktransforms === true && String(by(id2).parent) === gid && !("parent" in by(id1)) && !by(gid).image && json(objsAD.map((o) => String(o.id))) === json([id1, gid, id2]), `盘上 scene.json：锁定字段、父子关系、组对象、绘制顺序都在（${savedAD[0]}）`);

  await reopen(savedAD[0]);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 3`, 90000);
  await waitFor(`/首帧就绪|First frame ready/.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await settle();
  var crD2 = await h.canvasRect();
  check((await ev(`document.querySelector('#ed-tree .ed-node[data-id="${id1}"]').classList.contains('locked-layer')`)) && (await depthOf())[id2] === 1 && (await inkIn(...worldBox(crD2, [400, 540], [50, 30]))).frac > 0.05 && (await inkIn(...worldBox(crD2, [1700, 540], [50, 30]))).frac > 0.05, "重新打开：锁定状态、组结构、画面都还在");

  } catch (err) { await hlAbort("AD", "AD. 图层树拖拽改父级 / 成组 / 锁定写入文档（成组 → 移动组子层跟随 → 拖进组画面不动 → 拖出 → 成环拒绝 → 撤销 → 锁定 → 存库 → 重开）", err); }
  section("AE. 视口拖拽吸附（贴画面竖中线 + 粉色参考线 → 松手消失 → ⌘ 关吸附 → 贴另一层中心）");
  if (hlState.dead) hlSkip("AE", "AE. 视口拖拽吸附（贴画面竖中线 + 粉色参考线 → 松手消失 → ⌘ 关吸附 → 贴另一层中心）"); else try {
  var guidePx = () =>
    ev(`(() => { const c = document.querySelector('#ed-overlay'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40 && d[i] > d[i + 1] + 60 && d[i + 2] > d[i + 1] + 30) n++; return n; })()`);
  var holdDrag = async ([x0, y0], [x1, y1], modifiers = 0) => {
    await mouse("mouseMoved", x0, y0, { modifiers });
    await mouse("mousePressed", x0, y0, { buttons: 1, modifiers });
    for (let i = 1; i <= 10; i++) {
      await mouse("mouseMoved", x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10, { buttons: 1, modifiers });
      await new Promise((r) => setTimeout(r, 16));
    }
    await new Promise((r) => setTimeout(r, 150));
    return async () => {
      await mouse("mouseReleased", x1, y1, { modifiers });
      await settle();
    };
  };
  await gotoEditor();
  await newBlank("#000000");
  await addTextPreset("plain");
  await setText("content", "MMM");
  await setText("size", "60");
  await h.setInputs({ 0: 600, 1: 700 });
  await settle();
  var crE = await h.canvasRect();
  var release = await holdDrag(worldToPage(crE, [600, 700]), worldToPage(crE, [963, 700]));
  var gDuring = await guidePx();
  await release();
  var pos = await h.numInputs();
  check(Math.abs(pos[0] - 960) < 0.05 && Math.abs(pos[1] - 700) < 0.5, `★ 拖到离画面竖中线 3 个单位处松手：吸到 x = ${pos[0]}（y ${pos[1]} 不动）`);
  check(gDuring > 200 && (await guidePx()) === 0, `拖动中画出粉色参考线（${gDuring} 像素），松手后消失`);
  release = await holdDrag(worldToPage(crE, [960, 700]), worldToPage(crE, [970, 700]), MOD.meta);
  var gMeta = await guidePx();
  await release();
  pos = await h.numInputs();
  check(Math.abs(pos[0] - 970) < 1 && gMeta === 0, `按住 ⌘ 拖 10 个单位（无 ⌘ 时会被吸回中线）：不吸附、无参考线（x = ${pos[0].toFixed(2)}）`);
  await addTextPreset("plain");
  await setText("content", "WWW");
  await setText("size", "60");
  await h.setInputs({ 0: 1400, 1: 300 });
  await settle();
  await click(await ev(`(() => { const n = [...document.querySelectorAll('#ed-tree .ed-node')][0]; const r = n.getBoundingClientRect(); return [r.left + 60, r.top + r.height / 2]; })()`));
  await settle();
  release = await holdDrag(worldToPage(crE, [pos[0], 700]), worldToPage(crE, [1403, 700]));
  await release();
  pos = await h.numInputs();
  check(Math.abs(pos[0] - 1400) < 0.05, `★ 拖到另一层中心附近：吸到它的中心线 x = ${pos[0]}`);
  check((await h.errorLines()).length === 0, "吸附拖拽全程无错误");

  } catch (err) { await hlAbort("AE", "AE. 视口拖拽吸附（贴画面竖中线 + 粉色参考线 → 松手消失 → ⌘ 关吸附 → 贴另一层中心）", err); }
  section("AF. 多选（⇧ 点加选 → 左对齐 → 一步撤销 → 水平等距 → 一起拖动 → 多层成组 → 一起删除 → 画面 ⇧ 点）");
  if (hlState.dead) hlSkip("AF", "AF. 多选（⇧ 点加选 → 左对齐 → 一步撤销 → 水平等距 → 一起拖动 → 多层成组 → 一起删除 → 画面 ⇧ 点）"); else try {
  await gotoEditor();
  await newBlank("#000000");
  for (const [x, y] of [[300, 250], [900, 800], [1600, 540]]) {
    await addTextPreset("plain");
    await setText("content", "MMM");
    await setText("size", "12");
    await h.setInputs({ 0: x, 1: y });
  }
  await settle();
  var crF = await h.canvasRect();
  var inkF = async (x, y) => (await inkIn(...worldBox(await h.canvasRect(), [x, y], [40, 25]), 690)).frac;
  var [f1, f2, f3] = await treeIds();
  await clickRow(f1);
  await click(await rowAt(f2), MOD.shift);
  await click(await rowAt(f3), MOD.meta);
  await settle();
  check((await ev(`document.querySelectorAll('#ed-tree .ed-node.selected').length`)) === 3 && /3/.test(await ev(`document.querySelector('.ed-multi .ed-insp-title')?.textContent ?? ''`)) && (await ev(`document.querySelectorAll('.ed-align-bar [data-align]').length`)) === 8, "⇧ / ⌘ 点树行：三层选中，检视器出「已选 3 个图层」与 8 个对齐按钮");
  await clickSel('.ed-align-bar [data-align="left"]');
  await settle();
  check((await inkF(300, 800)) > 0.05 && (await inkF(300, 540)) > 0.05 && (await inkF(900, 800)) < 0.01 && (await inkF(1600, 540)) < 0.01, "★ 左对齐：三层的左缘对齐到最左那层（同宽文字 → 都到 x=300）");
  await key("z", MOD.meta);
  await settle();
  check((await inkF(900, 800)) > 0.05 && (await inkF(1600, 540)) > 0.05 && (await inkF(300, 800)) < 0.01, "撤销一次：三层一起回原位（批量命令）");
  await clickSel('.ed-align-bar [data-align="hdist"]');
  await settle();
  check((await inkF(950, 800)) > 0.05 && (await inkF(800, 800)) < 0.01 && (await inkF(300, 250)) > 0.05 && (await inkF(1600, 540)) > 0.05, "★ 水平等距：首尾不动，中间那层移到 x=950");
  await key("z", MOD.meta);
  await settle();
  var crF2 = await h.canvasRect();
  var fromF = worldToPage(crF2, [300, 250]);
  var kF = crF2.w / 1920;
  await drag(fromF, [fromF[0] + 200 * kF, fromF[1]]);
  await settle();
  check((await inkF(500, 250)) > 0.05 && (await inkF(1100, 800)) > 0.05 && (await inkF(1800, 540)) > 0.05 && (await inkF(750, 800)) < 0.01, "★ 拖主选层右移 200：另外两层跟着移");
  await key("z", MOD.meta);
  await settle();
  check((await inkF(300, 250)) > 0.05 && (await inkF(900, 800)) > 0.05 && (await inkF(1600, 540)) > 0.05 && (await inkF(1800, 540)) < 0.01, "撤销一次：三层一起回去");
  var rf = await h.readyCount();
  await clickSel("#ly-group");
  await h.waitRemount(rf);
  var depF = await depthOf();
  check(json(await treeIds()).length > 0 && (await treeIds()).length === 4 && [f1, f2, f3].every((id) => depF[id] === 1) && (await inkF(900, 800)) > 0.05 && (await inkF(1600, 540)) > 0.05, "多层成组：三层进同一个新组，画面不变");
  rf = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rf);
  await clickRow(f1);
  await click(await rowAt(f3), MOD.shift);
  await settle();
  rf = await h.readyCount();
  await key("Delete");
  await h.waitRemount(rf);
  check(json(await treeIds()) === json([f2]) && (await inkF(900, 800)) > 0.05 && (await inkF(300, 250)) < 0.01, "选两层按 Delete：两层一起删");
  rf = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rf);
  await clickRow(f1);
  await click(worldToPage(await h.canvasRect(), [1600, 540]), MOD.shift);
  await settle();
  check((await ev(`[...document.querySelectorAll('#ed-tree .ed-node.selected')].map((n) => n.dataset.id).sort().join()`)) === [f1, f3].sort().join(), "画面上 ⇧ 点另一层：加入选中");
  check((await h.errorLines()).length === 0, "多选全程无错误");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AF", "AF. 多选（⇧ 点加选 → 左对齐 → 一步撤销 → 水平等距 → 一起拖动 → 多层成组 → 一起删除 → 画面 ⇧ 点）", err); }
  section("AG. 效果扩充集出帧（描边 / 外发光 / 色差 / 像素化 / 扫光 / 渐隐遮罩）");
  if (hlState.dead) hlSkip("AG", "AG. 效果扩充集出帧（描边 / 外发光 / 色差 / 像素化 / 扫光 / 渐隐遮罩）"); else try {
  /** 页面矩形内各类像素占比（黑底；选中框画布已隐藏） */
  var fxStats = async ([x0, y0], [x1, y1]) => {
    const clip = { x: Math.min(x0, x1), y: Math.min(y0, y1), width: Math.max(2, Math.abs(x1 - x0)), height: Math.max(2, Math.abs(y1 - y0)), scale: 1 };
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip });
    return ev(`(async () => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height).data; const n = d.length / 4; let white = 0, red = 0, blue = 0, lit = 0, edges = 0, cool = 0, warm = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      if (r + gg + b > 690) white++;
      if (r > 120 && gg < 90 && b < 90) red++;
      if (b > 120 && r < 90 && gg < 90) blue++;
      if (r + gg + b > 90) lit++;
      if (b > 110 && b > r + 30 && b >= gg) cool++;
      if (r > 110 && r > b + 30 && r > gg) warm++;
      if (i % (bmp.width * 4) !== 0 && Math.abs(r + gg + b - d[i - 4] - d[i - 3] - d[i - 2]) > 300) edges++;
    }
    return { white: white / n, red: red / n, blue: blue / n, lit: lit / n, edges, cool: cool / n, warm: warm / n };
    })()`);
  };
  await gotoEditor();
  await newBlank("#000000");
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  await addTextPreset("plain");
  await setText("content", "MMM");
  await setText("size", "24");
  await h.setInputs({ 0: 960, 1: 540 });
  await settle();
  var gBox = () => h.canvasRect().then((cr) => worldBox(cr, [960, 540], [450, 200]));
  var base = await fxStats(...(await gBox()));
  check(base.white > 0.01 && base.red === 0 && base.blue === 0, `基线：白字黑底，无红无蓝（白 ${base.white.toFixed(3)}）`);

  await fxAdd("outline");
  await fxSet(0, "color", "#ff0000");
  await fxSet(0, "width", "4");
  await settle();
  var ol = await fxStats(...(await gBox()));
  check(ol.red > 0.005 && ol.white > base.white * 0.6, `★ 描边：字形外出现红边、白字仍在（红 ${ol.red.toFixed(3)} / 白 ${ol.white.toFixed(3)}）`);
  await fxSet(0, "width", "0");
  await settle();
  var ol0 = await fxStats(...(await gBox()));
  check(ol0.red < ol.red * 0.2, `描边宽 0：红边消失（红 ${ol0.red.toFixed(3)}）`);
  await fxBtn(0, "ed-fx-del");

  await fxAdd("glow");
  await fxSet(0, "color", "#ff0000");
  await fxSet(0, "radius", "5");
  await fxSet(0, "strength", "3");
  await settle();
  var gw = await fxStats(...(await gBox()));
  check(gw.red > 0.005 && gw.white > base.white * 0.6, `★ 外发光：字周围红色光晕、白字不被盖住（红 ${gw.red.toFixed(3)}）`);
  await fxSet(0, "strength", "0");
  await settle();
  check((await fxStats(...(await gBox()))).red < gw.red * 0.2, "外发光强度 0：光晕消失");
  await fxBtn(0, "ed-fx-del");

  await fxAdd("chroma");
  await fxSet(0, "amount", "0.02");
  await settle();
  var ch = await fxStats(...(await gBox()));
  check(ch.red > 0.002 && ch.blue > 0.002, `★ 色差：一侧红边一侧蓝边（红 ${ch.red.toFixed(3)} / 蓝 ${ch.blue.toFixed(3)}）`);
  await fxSet(0, "amount", "0");
  await settle();
  var ch0 = await fxStats(...(await gBox()));
  check(ch0.red < 0.0005 && ch0.blue < 0.0005, "色差 0：红蓝边消失");
  await fxBtn(0, "ed-fx-del");
  await settle();
  check(Math.abs((await fxStats(...(await gBox()))).white - base.white) < base.white * 0.1, "删掉效果：回到基线");

  // 磁流体：效果作用域是图层 quad（文字层 ≈ 文字外框），24px 小字会把流体缩成
  // 一小团、边缘光被 AA 稀释 —— 先放大字号给流体足够的屏上面积再判。
  await setText("size", "400");
  await settle();
  var fxMid = () => h.canvasRect().then((cr) => worldBox(cr, [960, 540], [560, 330]));
  var flBase = await fxStats(...(await fxMid()));
  await fxAdd("cuiliuti");
  await settle();
  // 编辑器页默认暂停：g_Time 不走流体就不动（shine 块同一前置），先起播再判动画。
  if (!(await ev(`document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`))) await clickSel("#tb-play");
  var fl = await fxStats(...(await fxMid()));
  check(fl.cool > 0.0004 && fl.warm > 0.0004, `★ 磁流体：左蓝右橙边缘光出现（冷 ${fl.cool.toFixed(4)} / 暖 ${fl.warm.toFixed(4)}）`);
  check(fl.white < flBase.white * 0.9, `磁流体黑色本体盖住白字（白 ${fl.white.toFixed(3)} < ${flBase.white.toFixed(3)}）`);
  var flA = await fxStats(...(await fxMid()));
  await new Promise((r) => setTimeout(r, 800));
  var flB = await fxStats(...(await fxMid()));
  check(flA.edges !== flB.edges || Math.abs(flA.lit - flB.lit) > 0.0004, `磁流体在动（edges ${flA.edges}→${flB.edges} / lit ${flA.lit.toFixed(4)}→${flB.lit.toFixed(4)}）`);
  await fxBtn(0, "ed-fx-del");
  await settle();
  var flEnd = await fxStats(...(await fxMid()));
  check(Math.abs(flEnd.white - flBase.white) < flBase.white * 0.15, "删掉磁流体：回到大字基线");

  await gotoEditor();
  await newBlank("#000000");
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  await addImage(stripePath);
  await settle();
  var crS = await h.canvasRect();
  var sRed = worldToPage(crS, [1110, 590]);
  var sBlue = worldToPage(crS, [1110, 490]);
  var nearTop = worldToPage(crS, [1110, 560]);
  var nearBot = worldToPage(crS, [1110, 520]);
  var sideL = worldToPage(crS, [790, 590]);
  var sideR = worldToPage(crS, [1130, 590]);
  check(isRed(await pixelAt(nearTop)) && isBlue(await pixelAt(nearBot)), "条纹图基线：分界线两侧 20 单位一红一蓝");

  await fxAdd("pixelate");
  await fxSet(0, "size", "64");
  await settle();
  var pT = await pixelAt(nearTop);
  var pB = await pixelAt(nearBot);
  check(close(pT, pB, 10) && (isRed(pT) || isBlue(pT)), `★ 像素化 64：分界线所在的 64px 格整体同色（上 ${pT} / 下 ${pB}）`);
  check(isRed(await pixelAt(sRed)) && isBlue(await pixelAt(sBlue)), "远离分界的格子颜色不变");
  await fxSet(0, "size", "1");
  await settle();
  check(isRed(await pixelAt(nearTop)) && isBlue(await pixelAt(nearBot)), "像素块 1：等同原图");
  await fxBtn(0, "ed-fx-del");

  await fxAdd("fade");
  await fxSet(0, "start", "0");
  await fxSet(0, "end", "1");
  await settle();
  var fdL = await pixelAt(sideL);
  var fdR = await pixelAt(sideR);
  check(fdL[0] < 40 && isRed(fdR), `★ 渐隐遮罩 0→1：左缘透明（露黑底 ${fdL}）、右缘不透明（${fdR}）`);
  await fxSet(0, "start", "1");
  await fxSet(0, "end", "0");
  await settle();
  var fdL2 = await pixelAt(sideL);
  var fdR2 = await pixelAt(sideR);
  check(isRed(fdL2) && fdR2[0] < 40, `起点 > 终点：方向反过来（左 ${fdL2} / 右 ${fdR2}）`);
  await fxBtn(0, "ed-fx-del");

  await fxAdd("shine");
  await fxSet(0, "color", "#00ff00");
  await fxSet(0, "speed", "1");
  await fxSet(0, "width", "0.3");
  await fxSet(0, "strength", "2");
  if (!(await ev(`document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`))) await clickSel("#tb-play");
  var greens = [];
  for (let i = 0; i < 12; i++) {
    greens.push((await pixelAt(worldToPage(await h.canvasRect(), [960, 590])))[1]);
    await new Promise((r) => setTimeout(r, 110));
  }
  check(Math.max(...greens) > 150 && Math.min(...greens) < 60, `★ 扫光：同一点绿色随时间扫过又离开（G 序列 ${greens.join(",")}）`);
  await fxSet(0, "speed", "0");
  await fxSet(0, "strength", "0");
  await settle();
  check(isRed(await pixelAt(sRed)), "扫光强度 0：原图");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  check((await h.errorLines()).length === 0, "效果扩充集全程无错误");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AG", "AG. 效果扩充集出帧（描边 / 外发光 / 色差 / 像素化 / 扫光 / 渐隐遮罩）", err); }
  section("AH. 时间轴按层动画条 / 关键帧复制粘贴（A 层 2s 关键帧 → 复制 → B 层 1s 粘贴 → 画面 → 撤销 → 点动画条选层）");
  if (hlState.dead) hlSkip("AH", "AH. 时间轴按层动画条 / 关键帧复制粘贴（A 层 2s 关键帧 → 复制 → B 层 1s 粘贴 → 画面 → 撤销 → 点动画条选层）"); else try {
  await gotoEditor();
  await newBlank("#000000");
  for (const [x, y] of [[400, 300], [400, 800]]) {
    await addTextPreset("plain");
    await setText("content", "MMM");
    await setText("size", "12");
    await h.setInputs({ 0: x, 1: y });
  }
  await settle();
  var [hA, hB] = await treeIds();
  var lanes = () => ev(`document.querySelector('#tl-lanes').hidden ? null : [...document.querySelectorAll('#tl-lanes .tl-lane')].map((r) => ({ id: r.dataset.id, keys: [...r.querySelectorAll('.tl-lane-key')].map((k) => Number(k.dataset.t)), repeat: !!r.querySelector('.tl-lane-bar.is-repeat'), sel: r.classList.contains('selected') }))`);
  check((await lanes()) === null, "没有动画层：动画条区隐藏");
  await clickRow(hA);
  if (await ev(`document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`)) await clickSel("#tb-play");
  await seekTo(0);
  await animOn("origin", true);
  var ln = await lanes();
  check(ln?.length === 1 && ln[0].id === hA && json(ln[0].keys) === json([0]) && ln[0].repeat && ln[0].sel, `A 开位置动画：出一行动画条（选中高亮、0s 一枚关键帧、loop 后续周期虚条）${json(ln)}`);
  var barPct = await ev(`(() => { const b = document.querySelector('#tl-lanes .tl-lane-bar:not(.is-repeat)'); return b.getBoundingClientRect().width / b.parentElement.getBoundingClientRect().width; })()`);
  check(Math.abs(barPct - 3 / 30) < 0.01, `实条长度 = 动画时长 3s / 时间轴 30s（${barPct.toFixed(3)}）`);
  await seekTo(2);
  var rh = await h.readyCount();
  await h.setInputs({ 0: 1400 });
  await h.waitRemount(rh);
  ln = await lanes();
  check(json(ln?.[0].keys) === json([0, 2]), `2s 落关键帧后动画条上两枚（${json(ln?.[0].keys)}）`);
  var align = await ev(`(() => { const a = [...document.querySelectorAll('#tl-lanes .tl-lane-key')].find((k) => k.dataset.t === '2').getBoundingClientRect(); const b = [...document.querySelectorAll('#tl-keys .tl-key')].find((k) => k.dataset.t === '2').getBoundingClientRect(); return Math.abs((a.left + a.width / 2) - (b.left + b.width / 2)); })()`);
  check(align < 2, `动画条与上方滑轨同一时间刻度：2s 关键帧横向对齐（差 ${align.toFixed(2)}px）`);

  await seekTo(1);
  check(await ev(`document.querySelector('.ed-anim [data-anim-copy]').disabled && document.querySelector('.ed-anim [data-anim-paste]').disabled`), "1s 没有关键帧：「复制此刻关键帧」不可用；剪贴板空：「粘贴」不可用");
  await seekTo(2);
  await clickSel(".ed-anim [data-anim-copy]");
  await settle();
  check(await ev(`!document.querySelector('.ed-anim [data-anim-paste]').disabled`), "2s 复制后「粘贴到此刻」可用");
  await clickRow(hB);
  await seekTo(1);
  check(await ev(`!document.querySelector('.ed-anim [data-anim-paste]').disabled && !document.querySelector('.ed-anim [data-anim-on="origin"]').checked`), "切到没有动画的 B 层：粘贴仍可用（剪贴板跨层）");
  rh = await h.readyCount();
  await clickSel(".ed-anim [data-anim-paste]");
  await h.waitRemount(rh);
  var bo = await rawObj();
  check(json(keysOf(bo)) === json([[0, 400], [30, 1400]]) && json(keysOf(bo, 1)) === json([[0, 800], [30, 300]]), `★ B 层 1s 粘贴：自动开位置动画，第 0 帧 = 原位置，第 30 帧 = A 在 2s 的值（x ${json(keysOf(bo))} / y ${json(keysOf(bo, 1))}）`);
  ln = await lanes();
  check(ln?.length === 2 && json(ln.map((r) => r.id)) === json([hA, hB]) && json(ln[1].keys) === json([0, 1]) && ln[1].sel && !ln[0].sel, "动画条两行（按图层树顺序），B 行选中、关键帧 0s / 1s");
  var inkH = async (x, y) => (await inkIn(...worldBox(await h.canvasRect(), [x, y], [40, 25]), 690)).frac;
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkH(1400, 300)) > 0.05 && (await inkH(400, 800)) < 0.01, "★ 画面：1s 时 B 层到了 (1400, 300)，原位置空了");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  rh = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rh);
  check(!(await rawObj()).origin?.animation && (await lanes())?.length === 1, "撤销粘贴：B 层动画整个撤回，动画条回到一行");
  await clickSel(`#tl-lanes .tl-lane[data-id="${hA}"]`);
  await settle();
  check((await h.selectedName()) !== null && (await ev(`document.querySelector('#ed-tree .ed-node.selected')?.dataset.id`)) === hA && (await lanes())[0].sel, "点动画条那一行：选中对应图层");
  check((await h.errorLines()).length === 0, "动画条 / 复制粘贴全程无错误");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AH", "AH. 时间轴按层动画条 / 关键帧复制粘贴（A 层 2s 关键帧 → 复制 → B 层 1s 粘贴 → 画面 → 撤销 → 点动画条选层）", err); }
  section("AL. M7 交互补齐（框选 → 批改 → 撤销 → 取消成组 → 树搜索 / 隔离 → 图层剪贴板跨文档）");
  if (hlState.dead) hlSkip("AL", "AL. M7 交互补齐（框选 → 批改 → 撤销 → 取消成组 → 树搜索 / 隔离 → 图层剪贴板跨文档）"); else try {
  await gotoEditor();
  await newBlank("#000000");
  for (const [x, y] of [[220, 200], [650, 200], [1600, 800]]) {
    await addTextPreset("plain");
    await setText("content", "MMM");
    await setText("size", "12");
    await h.setInputs({ 0: x, 1: y });
  }
  await settle();
  var [q1, q2, q3] = await treeIds();
  var crAj = await h.canvasRect();
  var inkAj = async (x, y) => (await inkIn(...worldBox(await h.canvasRect(), [x, y], [40, 25]), 690)).frac;
  // 空画布起拖：从 (1200, 800) 拉到 (300, 100)，矩形罩住左上两层、放过右下那层。
  // 叠加层先隐藏：虚线矩形与选中框会压在命中测试区上，量的是框选结果不是像素
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  await drag(worldToPage(crAj, [1200, 800]), worldToPage(crAj, [300, 100]), 0, 12);
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  check(
    json(await ev(`[...document.querySelectorAll('#ed-tree .ed-node.selected')].map((n) => n.dataset.id).sort()`)) === json([q1, q2].sort()),
    "★ 拖空白处框选：相交的两层进选区，矩形外的第三层不动",
  );
  await clickSel('.ed-align-bar [data-align="left"]');
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkAj(220, 200)) > 0.05 && (await inkAj(220, 200)) > 0.05 && (await inkAj(650, 200)) < 0.01 && (await inkAj(1600, 800)) > 0.05, "★ 框选后批改：左对齐把第二层移到第一层的左缘，矩形外的层不受影响");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  await key("z", MOD.meta);
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkAj(650, 200)) > 0.05 && (await inkAj(220, 200)) > 0.05 && (await inkAj(1600, 800)) > 0.05, "撤销一次：批改整体回退（框选走的是同一条批量命令）");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  var rm = await h.readyCount();
  await clickSel("#ly-group");
  await h.waitRemount(rm);
  check((await treeIds()).length === 4 && (await depthOf())[q1] === 1 && (await depthOf())[q2] === 1, "框选出的两层成组");
  // 取消成组要求选中「带子层的组」：先把按钮的可用口径钉成判据（选中叶子层时必须禁用），
  // 再选中组本身（树里 depth 0 且不是第三层的那一行）才点。原先直接点 q1 会让按钮停在
  // 禁用态、点击什么也不做，随后 waitRemount 干等 60s —— 那是本段自己的用例写错，不是产品缺陷。
  await clickRow(q1);
  check(
    (await ev(`document.querySelector('#ly-ungroup').disabled`)) === true,
    "选中没有子层的叶子层时「取消成组」禁用（不会静默什么都不做）",
  );
  var grpAj = Object.entries(await depthOf()).find(([id, d]) => d === 0 && id !== q3)?.[0];
  check(typeof grpAj === "string" && (await treeIds()).length === 4, "成组后树里能认出唯一的新组（depth 0 且非第三层）");
  await clickRow(grpAj);
  check(
    (await ev(`document.querySelector('#ly-ungroup').disabled`)) === false,
    "选中带子层的组时「取消成组」可用",
  );
  rm = await h.readyCount();
  await clickSel("#ly-ungroup");
  await h.waitRemount(rm);
  check((await treeIds()).length === 3 && (await treeIds())[0] === q1 && (await treeIds())[1] === q2, "★ 取消成组：组消失，两个子层按原顺序顶回顶层");
  check((await inkAj(220, 200)) > 0.05 && (await inkAj(650, 200)) > 0.05, "取消成组后画面不变（子层补偿了组的变换）");

  // 树搜索 / 隔离 / 折叠全部
  await ev(
    `(() => { const el = document.querySelector('#ed-filter'); el.value = '${q2}'; el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );
  await settle();
  check(json(await treeIds()) === json([q2]) && (await ev(`document.querySelectorAll('#ed-tree .ed-node.match').length`)) === 1, "★ 树搜索：按 id 过滤只剩命中行，命中行带 .match 高亮");
  await clickSel("#ed-filter-clear");
  await settle();
  check((await treeIds()).length === 3 && (await ev(`document.querySelector('#ed-filter').value`)) === "", "清空搜索：过滤撤销，三行都在");
  await clickRow(q3);
  // ★ 真机可达性：左栏默认 280px，面板头（两个标签页 + 三个树工具）曾装不下，
  // 工具被推到自己栏的框外、被中栏面板盖住 —— 真机点下去命中的是中栏的标签页。
  var hittable = async (sel) =>
    ev(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); const r = b.getBoundingClientRect(); const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!t && (t === b || b.contains(t)); })()`);
  var toolsHit = [];
  for (const sel of ["#tree-collapse", "#tree-expand", "#tree-isolate"]) toolsHit.push(await hittable(sel));
  check(toolsHit.every(Boolean), `★ 面板头的树工具真的能点到（命中测试落在按钮自己身上：折叠 / 展开 / 隔离 = ${json(toolsHit)}）`);
  await clickSel("#tree-isolate");
  await settle();
  check(json(await treeIds()) === json([q3]) && (await ev(`document.querySelector('#tree-isolate').classList.contains('is-on')`)), "★ 隔离：只留选中层这一支，按钮进入开启态");
  await clickSel("#tree-isolate");
  await settle();
  check((await treeIds()).length === 3 && !(await ev(`document.querySelector('#tree-isolate').classList.contains('is-on')`)), "再点隔离：恢复整棵树");
  await clickSel("#tree-collapse");
  await settle();
  // 每行都有一个 .ed-twisty 占位符（没有子层时是空 span），所以口径是「没有一行带展开箭头」
  check(
    (await treeIds()).length === 3 &&
      (await ev(`[...document.querySelectorAll('#ed-tree .ed-twisty')].filter((t) => (t.textContent || '').trim() !== '').length`)) === 0,
    "折叠全部：没有可折叠的组时树仍是平的（每行只有占位符，没有展开箭头）",
  );
  await clickSel("#tree-expand");
  await settle();
  check((await treeIds()).length === 3, "展开全部：三行恢复");

  // 锁定入撤销栈：锁定后拖不动，撤销后又能拖
  var lockBtn = (id) => `#ed-tree .ed-node[data-id="${id}"] .ed-lock`;
  await clickRow(q1);
  var crL = await h.canvasRect();
  await clickSel(lockBtn(q1));
  await settle();
  check(await ev(`document.querySelector('#ed-tree .ed-node[data-id="${q1}"]').classList.contains('locked-layer')`), "锁定按钮：行进入 locked-layer 态");
  await drag(worldToPage(crL, [220, 200]), worldToPage(crL, [520, 200]));
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkAj(220, 200)) > 0.05 && (await inkAj(520, 200)) < 0.01, "锁定层拖不动（写入文档的 locktransforms）");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  await key("z", MOD.meta);
  await settle();
  check(await ev(`!document.querySelector('#ed-tree .ed-node[data-id="${q1}"]').classList.contains('locked-layer')`), "★ 撤销一次：锁定被撤掉（锁定切换进了撤销栈）");
  await drag(worldToPage(crL, [220, 200]), worldToPage(crL, [520, 200]));
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkAj(520, 200)) > 0.05 && (await inkAj(220, 200)) < 0.01, "解锁后又能拖（撤销真的恢复了可拖状态）");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);
  await key("z", MOD.meta);
  await settle();

  // 图层剪贴板：⌘C / ⌘V 复制黏贴，⌘X 剪切；跨文档粘贴
  var originOf = async () => {
    const v = await h.numInputs();
    return `${v[0]}, ${v[1]}`;
  };
  await clickRow(q1);
  var baseOrigin = await originOf();
  var rowsBeforeAj = (await treeIds()).length;
  await key("c", MOD.meta);
  await settle();
  await key("v", MOD.meta);
  await settle();
  var rowsAfterAj = (await treeIds()).length;
  var pastedOrigin = await originOf();
  // 两个条件分开写进文案：合在一条 `&&` 里时失败信息分不清是哪半挂了
  check(
    rowsAfterAj === rowsBeforeAj + 1 && pastedOrigin !== baseOrigin,
    `⌘C + ⌘V：树里多一层并选中它，落点带粘贴偏移（行 ${rowsBeforeAj} → ${rowsAfterAj}，原点 ${json(baseOrigin)} → ${json(pastedOrigin)}）`,
  );
  rm = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rm);
  check((await treeIds()).length === rowsBeforeAj, "撤销粘贴：新层撤回（粘贴走 structEdit，一步撤销）");
  await key("x", MOD.meta);
  await settle();
  check((await treeIds()).length === rowsBeforeAj - 1, "⌘X 剪切：原层被删（剪切 = 复制 + 删除，删除自己进撤销栈）");
  rm = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rm);
  check((await treeIds()).length === rowsBeforeAj, "撤销剪切：原层回来");
  // 跨文档：先在本文档复制，换一个空文档再粘。内存剪贴板的载荷 id 与目标文档必然同名，
  // 粘贴必须重新编号——粘贴两次得到两行就是「没有覆盖已有层」的行为证据
  await clickRow(q2);
  await key("c", MOD.meta);
  await settle();
  await gotoEditor();
  await newBlank("#000000");
  await settle();
  await key("v", MOD.meta);
  await settle();
  var rows1Aj = (await treeIds()).length;
  var crossOrigin = await originOf();
  await key("v", MOD.meta);
  await settle();
  var rows2Aj = (await treeIds()).length;
  check(rows1Aj === 1 && rows2Aj === 2 && rows2Aj === rows1Aj + 1, `★ 跨文档粘贴：空文档里贴出 1 层，再粘一次变 2 层（id 重新分配、不覆盖，第二层落点 ${json(crossOrigin)} 偏移）`);
  rm = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rm);
  check((await treeIds()).length === 1, "撤销一次：回到只贴了一层的状态");
  rm = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rm);
  check((await treeIds()).length === 0, "再撤销：空文档回到空");
  check((await h.errorLines()).length === 0, "M7 交互补齐全程无错误");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AL", "AL. M7 交互补齐（框选 → 批改 → 撤销 → 取消成组 → 树搜索 / 隔离 → 图层剪贴板跨文档）", err); }
  section("AI. WebGL 上下文丢失自愈（丢上下文 → 按当前文档重挂、编辑不丢 → 一分钟内第 4 次停手 → 手动重新加载）");
  if (hlState.dead) hlSkip("AI", "AI. WebGL 上下文丢失自愈（丢上下文 → 按当前文档重挂、编辑不丢 → 一分钟内第 4 次停手 → 手动重新加载）"); else try {
  await gotoEditor();
  await newBlank("#000000");
  await addTextPreset("plain");
  await setText("content", "MMM");
  await setText("size", "12");
  await h.setInputs({ 0: 600, 1: 540 });
  await settle();
  var inkC = async () => (await inkIn(...worldBox(await h.canvasRect(), [600, 540], [40, 25]), 690)).frac;
  var conHas = (re) => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${re}.test(d.textContent)).length`);
  var loseCtx = () =>
    ev(`(() => { const c = document.querySelector('#ed-stage canvas[data-webwallgl]'); c.dataset.probe = 'old'; const gl = c.getContext('webgl2'); const x = gl && gl.getExtension('WEBGL_lose_context'); if (!x) return false; x.loseContext(); return true; })()`);
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  var ink0 = await inkC();
  var names0 = await h.treeNames();
  check(ink0 > 0.05, `基线：文字在 (600, 540)（墨水 ${ink0.toFixed(3)}）`);
  var rCtx = await h.readyCount();
  check(await loseCtx(), "WEBGL_lose_context 可用，主动丢上下文");
  await h.waitRemount(rCtx);
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await conHas(/上下文丢失，正在按当前文档重建|lost its WebGL context/)) === 1, "控制台记一条「上下文丢失，正在重建」");
  check(await ev(`(() => { const cs = document.querySelectorAll('#ed-stage canvas[data-webwallgl]'); return cs.length === 1 && cs[0].dataset.probe !== 'old'; })()`), "换了一块新画布（旧的死画布已移除）");
  var ink1 = await inkC();
  check(ink1 > 0.05 && json(await h.treeNames()) === json(names0), `★ 重挂后画面恢复（墨水 ${ink1.toFixed(3)}），图层还在`);
  check(Math.abs((await h.numInputs())[0] - 600) < 0.5, "检视器里的编辑值仍在（x = 600）");
  for (let i = 0; i < 2; i++) {
    rCtx = await h.readyCount();
    await loseCtx();
    await h.waitRemount(rCtx);
  }
  check((await conHas(/上下文丢失，正在按当前文档重建|lost its WebGL context/)) === 3, "再丢两次：又自动重建两次（一分钟内共 3 次）");
  rCtx = await h.readyCount();
  await loseCtx();
  await new Promise((r) => setTimeout(r, 1500));
  check((await h.readyCount()) === rCtx && (await conHas(/停止自动重建|auto-rebuild stopped/)) === 1, "★ 一分钟内第 4 次：停止自动重建（不再重挂、记一条错误）");
  rCtx = await h.readyCount();
  await clickSel("#tb-reload");
  await h.waitRemount(rCtx);
  await settle();
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  check((await inkC()) > 0.05, "手动「重新加载」：画面回来");
  await ev(`document.querySelector('#ed-overlay').style.visibility = ''`);

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AI", "AI. WebGL 上下文丢失自愈（丢上下文 → 按当前文档重挂、编辑不丢 → 一分钟内第 4 次停手 → 手动重新加载）", err); }
  section("AJ. 视频（页面现录测试视频 → 以视频为背景 → 存盘 → 测试台 → 视频壁纸工程裁剪 / 撤销 / 存盘 / 转场景 → 场景录制为视频）");
  if (hlState.dead) hlSkip("AJ", "AJ. 视频（页面现录测试视频 → 以视频为背景 → 存盘 → 测试台 → 视频壁纸工程裁剪 / 撤销 / 存盘 / 转场景 → 场景录制为视频）"); else try {
  await runVideoSection();
  async function runVideoSection() {
  await gotoEditor();
  // 用编辑器自己的 recordVideo 现录 2 秒 320×180：上红下蓝，白块从左往右走
  const gen = await ev(`(async () => {
    const m = await import('/editor/video.ts');
    const c = new OffscreenCanvas(320, 180); const g = c.getContext('2d');
    const out = await m.recordVideo({ width: 320, height: 180, fps: 30, duration: 2, frameAt: async (t) => {
      g.fillStyle = 'rgb(220,30,30)'; g.fillRect(0, 0, 320, 90);
      g.fillStyle = 'rgb(30,30,220)'; g.fillRect(0, 90, 320, 90);
      g.fillStyle = '#fff'; g.fillRect((t / 2) * 300, 80, 20, 20);
      return c;
    } });
    const u = new Uint8Array(await out.blob.arrayBuffer()); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return { ext: out.ext, frames: out.frames, base64: btoa(s) };
  })()`, 120000);
  if (gen.ext !== "mp4") {
    console.log(`  · 无头浏览器不能编码 H.264（得到 ${gen.ext}），跳过视频端到端`);
    return;
  }
  const clipPath = path.join(tmpRoot, "clip.mp4");
  const clipBytes = Buffer.from(gen.base64, "base64");
  fs.writeFileSync(clipPath, clipBytes);
  check(gen.frames === 60 && clipBytes.readUInt32BE(4) === 0x66747970, `recordVideo 现录测试视频：60 帧 H.264 mp4（${clipBytes.length} 字节）`);

  const pixelUntil = async (pt, pred, ms = 6000) => {
    const t0 = Date.now();
    let c = await pixelAt(pt);
    while (!pred(c) && Date.now() - t0 < ms) {
      await new Promise((r) => setTimeout(r, 250));
      c = await pixelAt(pt);
    }
    return c;
  };
  await clickSel("#tb-new");
  const rcV = await h.readyCount();
  await clickSel("#new-video");
  await setFiles("#in-video", [clipPath]);
  await h.waitRemount(rcV);
  check(json(await h.treeNames()) === json(["clip"]) && (await ev(`document.querySelector('#ed-tree .ed-node .ed-kind')?.dataset.kind`)) === "video", "以视频为背景：一层视频层，树里标「视频」");
  const crV = await h.canvasRect();
  const vUp = await pixelUntil(worldToPage(crV, [150, 900]), isRed);
  const vDown = await pixelUntil(worldToPage(crV, [150, 150]), isBlue);
  check(isRed(vUp) && isBlue(vDown), `视频层铺满场景、引擎真画出视频帧（上 ${vUp} / 下 ${vDown}）`);
  await click(await h.rowCenter("clip"));
  check(/video-clip\.mp4/.test(await ev(`document.querySelector('#ed-inspector').textContent`)), "检视器显示视频文件信息");
  const idV = await saveLoose();
  const dirV = path.join(lib, idV);
  check(["models/editor/video-clip.json", "materials/editor/video-clip.json"].every((f) => fs.existsSync(path.join(dirV, f))) && Buffer.compare(fs.readFileSync(path.join(dirV, "materials/editor/video-clip.mp4")), clipBytes) === 0, "盘上视频层三件套，H.264 无音轨的 mp4 原字节保存（不重编码）");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${idV}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  const vpB = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchV = { x: 0, y: 0, w: vpB.w, h: vpB.h };
  const bvUp = await pixelUntil(worldToPage(benchV, [150, 900]), isRed, 10000);
  const bvDown = await pixelUntil(worldToPage(benchV, [150, 150]), isBlue, 10000);
  check(isRed(bvUp) && isBlue(bvDown), `测试台渲染页：松散 mp4 包成视频贴图播放（上 ${bvUp} / 下 ${bvDown}）`);

  // 视频壁纸工程
  await gotoEditor();
  await clickSel("#tb-new");
  await clickSel("#new-video-wp");
  await setFiles("#in-video", [clipPath]);
  const VREADY = `[...document.querySelectorAll('#ed-con-body > div')].filter((d) => /视频已就绪|Video ready/.test(d.textContent)).length`;
  await waitFor(`${VREADY} > 0`, 90000);
  const tlMax = () => ev(`Number(document.querySelector('#tl-range').max)`);
  check(!!(await ev(`document.querySelector('#ed-stage video[data-webwallgl-video]')`)) && Math.abs((await tlMax()) - 2) < 0.15, `视频壁纸工程：舞台放视频、时间轴长度 = 视频时长（${await tlMax()}s）`);
  check(/没有图层|no layers/.test(await ev(`document.querySelector('#ed-tree').textContent`)) && (await ev(`document.querySelectorAll('#ed-inspector [data-vp]').length`)) === 6, "图层面板说明无图层；检视器有入点 / 出点 / 清除 / 应用裁剪 / 替换 / 转场景");
  const vRect = await ev(`(() => { const r = document.querySelector('#ed-stage video').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  check(isRed(await pixelUntil(worldToPage(vRect, [150, 900]), isRed)) && isBlue(await pixelUntil(worldToPage(vRect, [150, 150]), isBlue)), "视频壁纸预览画面正确");
  const seekTo = (t) => ev(`(() => { const r = document.querySelector('#tl-range'); r.value = '${t}'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); return true; })()`);
  await seekTo(0.5);
  await new Promise((r) => setTimeout(r, 300));
  await ev(`document.querySelector('#ed-inspector [data-vp=in]').click()`);
  await seekTo(1.5);
  await new Promise((r) => setTimeout(r, 300));
  await ev(`document.querySelector('#ed-inspector [data-vp=out]').click()`);
  check((await ev(`document.querySelectorAll('#tl-keys .tl-trim').length`)) === 2, "时间轴标出入点 / 出点");
  let vr = await ev(VREADY);
  await ev(`document.querySelector('#ed-inspector [data-vp=apply]').click()`);
  await waitFor(`${VREADY} > ${vr}`, 120000);
  const trimmed = await tlMax();
  check(Math.abs(trimmed - 1) < 0.15 && /已裁剪视频|Trimmed video/.test(await ev(`document.querySelector('#ed-con-body').textContent`)), `应用裁剪：重新编码后时长 ≈ 1s（${trimmed}s）`);
  vr = await ev(VREADY);
  await key("z", MOD.meta);
  await waitFor(`${VREADY} > ${vr}`, 60000);
  check(Math.abs((await tlMax()) - 2) < 0.15, "撤销裁剪：视频回到 2s");
  vr = await ev(VREADY);
  await key("z", MOD.meta | MOD.shift);
  await waitFor(`${VREADY} > ${vr}`, 60000);
  check(Math.abs((await tlMax()) - 1) < 0.15, "重做裁剪：又是 1s");
  // 视频壁纸工程也默认建在浏览器存储里：先整份落到本机文件夹，再看盘上产物
  await saveToLocal();
  const scVp = await h.savedCount();
  await key("s", MOD.meta);
  await h.waitSaved(scVp);
  const idVp = await ev(`sessionStorage.getItem('wwgl-e2e-project')`);
  const dirVp = path.join(lib, idVp);
  await waitFileOnDisk(path.join(dirVp, "project.json"));
  const pjVp = JSON.parse(fs.readFileSync(path.join(dirVp, "project.json"), "utf8"));
  check(pjVp.type === "video" && pjVp.file === "clip.mp4" && fs.existsSync(path.join(dirVp, "preview.jpg")) && fs.statSync(path.join(dirVp, "clip.mp4")).size < clipBytes.length, "视频壁纸工程存盘：project.json(type=video) + 裁剪后的 clip.mp4 + 封面");
  const rcS = await h.readyCount();
  await ev(`document.querySelector('#ed-inspector [data-vp=to-scene]').click()`);
  await h.waitRemount(rcS);
  check(json(await h.treeNames()) === json(["clip"]) && /320×180/.test(await ev(`document.querySelector('#st-res').textContent`)), "转成场景：新场景以视频层铺底，分辨率取视频本身（320×180）");
  check((await h.errorLines()).length === 0, "视频层 / 视频工程全程无错误");

  // 场景录制为视频
  await gotoEditor();
  await newBlank("#202020");
  await addImage(stripePath);
  const crR = await h.canvasRect();
  const topR = worldToPage(crR, [960 + 150, 540 + 50]);
  await ev(`document.querySelector('#export-video').click()`);
  check(await ev(`!document.querySelector('#rec-menu').hidden`), "「录制为视频」弹出录制面板");
  await ev(`(() => { document.querySelector('#rec-duration').value = '0.5'; document.querySelector('#rec-fps').value = '30'; document.querySelector('#rec-res').value = '1280'; return true; })()`);
  const dl = await captureDownload(() => ev(`document.querySelector('#rec-start').click()`));
  const probe = await ev(`(async () => {
    const m = await import('/editor/video.ts');
    const b = await (await fetch('data:application/octet-stream;base64,${dl.base64}')).blob();
    return m.probeVideo(b);
  })()`, 60000);
  check(/\.mp4$/.test(dl.name) && probe.width === 1280 && probe.height === 720 && Math.abs(probe.duration - 0.5) < 0.1 && probe.codec === "avc", `录制下载 ${dl.name}：1280×720、0.5s、H.264（${json(probe)}）`);
  await waitFor(`document.querySelector('#rec-menu').hidden`, 10000);
  check(isRed(await pixelUntil(topR, isRed)) && (await ev(`Number(document.querySelector('#tl-range').value)`)) < 0.05, "录完画面复原到容器尺寸、回到原时刻");
  check((await h.errorLines()).length === 0, "录制全程无错误");
  }

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AJ", "AJ. 视频（页面现录测试视频 → 以视频为背景 → 存盘 → 测试台 → 视频壁纸工程裁剪 / 撤销 / 存盘 / 转场景 → 场景录制为视频）", err); }
  section("AK. 场景设置端到端（改 camerashake → 出帧变化）");
  if (hlState.dead) hlSkip("AK", "AK. 场景设置端到端（改 camerashake → 出帧变化）"); else try {
  await gotoEditor();
  await newBlank("#101010");
  await addImage(stripePath);
  await ev(`document.querySelector('#ed-overlay').style.visibility = 'hidden'`);
  // 编辑器页默认暂停：g_Time 不走，抖动偏移就恒定，出帧看不出变化 —— 先起播再比画面
  if (!(await ev(`document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`))) await clickSel("#tb-play");
  var crK = await h.canvasRect();
  var scnClip = { x: Math.round(crK.x), y: Math.round(crK.y), width: Math.round(crK.w), height: Math.round(crK.h), scale: 1 };
  /** 画面指纹：画布区域缩到 64×36 灰度。比的是「画面动没动」，不是某个像素的值 */
  var scnFp = async () => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: scnClip });
    return ev(`(async () => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const c = new OffscreenCanvas(64, 36); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data; const out = [];
      for (let i = 0; i < d.length; i += 4) out.push((d[i] * 3 + d[i + 1] * 6 + d[i + 2]) / 10);
      return out;
    })()`);
  };
  var scnGap = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
  /** 连采 n 张取与首张的最大差：静止画面 ≈ 0，抖动画面取到摆幅 */
  var scnSwing = async (n, ms) => {
    const fps = [];
    for (let i = 0; i < n; i++) {
      if (i) await new Promise((r) => setTimeout(r, ms));
      fps.push(await scnFp());
    }
    let mx = 0;
    for (let i = 1; i < fps.length; i++) mx = Math.max(mx, scnGap(fps[0], fps[i]));
    return { mx, first: fps[0] };
  };
  var scnSet = async (key, value) => {
    const rc = await h.readyCount();
    await ev(`(() => {
      const el = document.querySelector('#scene-menu-body [data-scene-key="${key}"] input');
      if (el.type === 'checkbox') el.checked = ${JSON.stringify(value)};
      else el.value = ${JSON.stringify(String(value))};
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await h.waitRemount(rc);
  };
  /** 视口工具条 overflow-x:auto：先把按钮滚进可见区，再按真实坐标点它（否则点到别的地方） */
  var scnClickOpts = async () => {
    await ev(`(() => { document.querySelector('#tb-scene-opts').scrollIntoView({ block: 'nearest', inline: 'nearest' }); return true; })()`);
    await clickSel("#tb-scene-opts");
  };
  /** 一步撤销（本段自带，不依赖后面才定义的 undoRedo）：等重挂，避免读到半截状态 */
  var scnUndo = async () => {
    const rc = await h.readyCount();
    await key("z", MOD.meta);
    await h.waitRemount(rc);
  };

  await scnClickOpts();
  check(await ev(`!document.querySelector('#scene-menu').hidden`), "工具条「场景设置」弹出面板（复用渲染菜单的样式）");
  check((await ev(`document.querySelectorAll('#scene-menu-body [data-scene-key]').length`)) === 29 && (await ev(`document.querySelectorAll('#scene-menu-body .ed-menu-title').length`)) === 5, "面板 29 个字段 / 5 个分组（清屏 · 相机 · 抖动 · 视差 · 泛光）");
  check(await ev(`(document.querySelector('#scene-menu-body [data-scene-key="camerashake"] .wb-field-val').textContent)`) === "未设置", "新建工程没写过 camerashake：面板标「未设置」（默认值只显示，不进文档）");
  check(await ev(`document.querySelector('#render-menu').hidden && !document.querySelector('#render-menu').contains(document.querySelector('#scene-menu'))`), "「场景设置」和全局「渲染选项」是两个独立菜单（不是同一个面板）");
  check(await ev(`/scene\\.json/.test(document.querySelector('#scene-menu').textContent)`), "面板里写明这些参数写进工程的 scene.json");
  await scnClickOpts();
  check(await ev(`document.querySelector('#scene-menu').hidden`), "再点一次收起（与渲染选项一致）");

  var baseK = await scnSwing(4, 120);
  check(baseK.mx < 0.6, `未开抖动：静止画面连采 4 张几乎不变（最大差 ${baseK.mx.toFixed(3)}）`);

  await scnClickOpts();
  await scnSet("camerashakeamplitude", 5);
  await scnSet("camerashake", true);
  check(await ev(`(document.querySelector('#scene-menu-body [data-scene-key="camerashake"] .wb-field-val').textContent)`) === "已设", "开一次抖动：文档里真写下了这个键（面板标「已设」）");
  await scnClickOpts();
  var shakeK = await scnSwing(8, 90);
  check(shakeK.mx > baseK.mx * 3 && shakeK.mx > 1, `★ 改 camerashake：出帧开始晃（最大差 ${shakeK.mx.toFixed(3)}，静止时 ${baseK.mx.toFixed(3)}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/scene-shake.jpg") });
  console.log("  截图：scripts/.tmp-editor-e2e/scene-shake.jpg");

  // 撤销：一次编辑一笔栈 —— 先收回 camerashake 这一笔，幅度那笔还在
  await ev(`document.activeElement && document.activeElement.blur()`);
  await scnUndo();
  await scnClickOpts();
  check(await ev(`(document.querySelector('#scene-menu-body [data-scene-key="camerashake"] .wb-field-val').textContent)`) === "未设置" && (await ev(`(document.querySelector('#scene-menu-body [data-scene-key="camerashakeamplitude"] .wb-field-val').textContent)`)) === "已设", "撤销一步只收回最后一笔（抖动关了，先写的幅度还在）");
  await scnClickOpts();
  var undoneK = await scnSwing(4, 120);
  check(undoneK.mx < 0.6 && scnGap(undoneK.first, baseK.first) < 1.2, `撤销后画面回到静止基线（连采最大差 ${undoneK.mx.toFixed(3)}，与基线差 ${scnGap(undoneK.first, baseK.first).toFixed(3)}）`);

  await ev(`document.activeElement && document.activeElement.blur()`);
  await scnUndo();
  var idK = await saveLoose();
  var genK = JSON.parse(fs.readFileSync(path.join(lib, idK, "scene.json"), "utf8")).general;
  check(!("camerashake" in genK) && !("camerashakeamplitude" in genK), `撤销到底：这次写进去的两个键都从盘上 scene.json 里收回了（现存 ${json(Object.keys(genK))}）`);
  check(json(genK.orthogonalprojection) === json({ width: 1920, height: 1080 }), "★ 撤销到底也没碰 orthogonalprojection（分辨率还在）");
  check((await h.errorLines()).length === 0, "场景设置全程无错误");

  // ════════════════════════════════════════════════════════════════════════
  } catch (err) { await hlAbort("AK", "AK. 场景设置端到端（改 camerashake → 出帧变化）", err); }
  section("AM. M9 命令面板 / 无障碍 / 脚本事件模板");
  if (hlState.dead) hlSkip("AM", "AM. M9 命令面板 / 无障碍 / 脚本事件模板"); else try {
  // 段内自带按键派发：共享的 KEYS 里没有 k / 方向键，这里不动它
  var amSend = async (k, code, vk, modifiers = 0) => {
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await settle();
  };
  var AMK = {
    k: ["k", "KeyK", 75],
    Escape: ["Escape", "Escape", 27],
    Enter: ["Enter", "Enter", 13],
    ArrowUp: ["ArrowUp", "ArrowUp", 38],
    ArrowDown: ["ArrowDown", "ArrowDown", 40],
    ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
    ArrowRight: ["ArrowRight", "ArrowRight", 39],
    Home: ["Home", "Home", 36],
    End: ["End", "End", 35],
  };
  var amPress = (k, modifiers = 0) => amSend(...AMK[k], modifiers);
  var amOpen = () => ev(`!!document.querySelector('#ed-palette')?.open`);
  var amRows = () =>
    ev(`[...document.querySelectorAll('#ed-palette-list .ed-palette-row')].map((r) => ({ id: r.dataset.command, name: (r.querySelector('.ed-palette-name') || {}).textContent || '', on: r.getAttribute('aria-selected') === 'true' }))`);
  var amType = async (q) => {
    await ev(`(() => { const i = document.querySelector('#ed-palette-input'); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await settle();
  };
  var amAria = (id, attr) => ev(`(document.querySelector('#ed-tree .ed-node[data-id="${id}"]') || {}).getAttribute ? document.querySelector('#ed-tree .ed-node[data-id="${id}"]').getAttribute('${attr}') : null`);
  var amActive = () => ev(`(document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null) || null`);
  var amFocusRow = (id) => ev(`(() => { const n = document.querySelector('#ed-tree .ed-node[data-id="${id}"]'); if (!n) return false; n.focus(); return document.activeElement === n; })()`);

  await gotoEditor();
  await newBlank("#000000");
  await addTextPreset("plain");
  await setText("content", "PAL");
  await setText("size", "60");
  var amA = String((await rawObj()).id);
  await addTextPreset("plain");
  await setText("content", "TREE");
  await setText("size", "60");
  var amB = String((await rawObj()).id);
  var amBefore = (await treeIds()).length;

  // ── C4：⌘K 打开 → 枚举注册表 → 过滤 / ↑↓ / Enter 执行 layer.duplicate / 动态快捷键总览 ──
  await ev(`document.activeElement && document.activeElement.blur()`);
  await amPress("k", MOD.meta);
  await waitFor(`!!document.querySelector('#ed-palette')?.open`, 30000);
  var amAll = await amRows();
  var amIds = amAll.map((r) => r.id);
  check(amIds.length >= 7 && amIds.includes("edit.undo") && amIds.includes("layer.duplicate"), `⌘K 打开命令面板，条目来自命令注册表（${json(amIds)}）`);
  check(amAll[0].id === "edit.undo" && amAll.filter((r) => r.on).length === 1 && amAll[0].on, "面板按注册顺序列出，只有一行处于选中态");
  check(amAll.every((r) => r.name && r.name !== r.id), `标题是本地化文案而不是裸 id（首条「${amAll[0].name}」）`);
  check((await ev(`document.querySelector('#ed-palette-input').getAttribute('aria-activedescendant')`)) === "ed-palette-opt-edit-undo", "输入框的 aria-activedescendant 指向当前选项");
  await amPress("ArrowDown");
  var amDown = await amRows();
  check(amDown[1].on && !amDown[0].on, "↓ 移动选择（aria-selected 跟着走）");
  await amPress("ArrowUp");
  check((await amRows())[0].on, "↑ 移回上一行");
  await amType("复制");
  var amHit = await amRows();
  check(amHit.length === 1 && amHit[0].id === "layer.duplicate", `输入过滤后只剩 layer.duplicate（${json(amHit.map((r) => r.id))}）`);
  await amType("zzz");
  check(await ev(`!!document.querySelector('#ed-palette-list .ed-palette-empty')`), "无命中时给空提示（不是空列表）");
  await amPress("Enter");
  check(await amOpen(), "无命中时 Enter 不执行、面板不崩（仍开着）");
  await amType("复制");
  await amPress("Enter");
  await waitFor(`!document.querySelector('#ed-palette')?.open`, 15000);
  var amAfter = (await treeIds()).length;
  check(amAfter === amBefore + 1, `★ Enter 执行注册表里的 layer.duplicate：图层 ${amBefore} → ${amAfter}`);
  await amPress("k", MOD.meta);
  await waitFor(`!!document.querySelector('#ed-palette')?.open`, 15000);
  check(await amOpen(), "⌘K 再按一次打开面板");
  await amPress("k", MOD.meta);
  await waitFor(`!document.querySelector('#ed-palette')?.open`, 15000);
  check(!(await amOpen()), "面板开着时 ⌘K 收起（开关语义）");
  await amPress("k", MOD.meta);
  await waitFor(`!!document.querySelector('#ed-palette')?.open`, 15000);
  check(await ev(`!!document.querySelector('#ed-palette-shortcuts')?.hidden`), "默认给命令列表（快捷键总览是切换出来的）");
  await clickSel("#ed-palette-keys");
  await settle();
  var amKeys = await ev(`[...document.querySelectorAll('#ed-palette-shortcuts .ed-palette-key-row')].map((r) => r.textContent.replace(/\\s+/g, ' ').trim())`);
  check(amKeys.length >= 6 && amKeys.some((t) => t.includes("⌘Z")) && amKeys.some((t) => t.includes("⇧⌘Z")), `快捷键总览由注册表生成（${amKeys.length} 行，键是平台写法：${json(amKeys.slice(0, 3))}）`);
  check(amKeys.every((t) => !t.includes("export.run")), "没有快捷键的命令不进总览");
  await amPress("Escape");
  await waitFor(`!document.querySelector('#ed-palette')?.open`, 15000);
  check(!(await amOpen()), "Esc 关闭面板（面板内焦点在输入框，窗口级 ⌘K 分支不会重复触发）");

  // ── C5：树无障碍（treeitem / roving tabindex / ↑↓ Home End / ←→ 折叠展开 / ⇧ 多选仍在） ──
  var amOrder = await treeIds();
  check((await ev(`document.querySelectorAll('#ed-tree [role="treeitem"]').length`)) === amOrder.length && amOrder.length >= 3, `树行都是 treeitem（${amOrder.length} 行）`);
  await clickRow(amOrder[1]);
  await settle();
  check((await amAria(amOrder[1], "aria-selected")) === "true" && (await amAria(amOrder[0], "aria-selected")) === "false", "点选：aria-selected 跟着选择走（其它行是 false）");
  check((await ev(`[...document.querySelectorAll('#ed-tree .ed-node')].filter((n) => n.tabIndex === 0).length`)) === 1, "roving tabindex：全树只有一个 tabindex=0 的行");
  check(await amFocusRow(amOrder[0]), "tabindex=0 的那行可以拿到键盘焦点");
  await amPress("ArrowDown");
  check((await amActive()) === amOrder[1] && (await amAria(amOrder[1], "aria-selected")) === "true", "↓ 焦点下移并同步选择");
  await amPress("End");
  var amLast = amOrder[amOrder.length - 1];
  check((await amActive()) === amLast && (await amAria(amLast, "aria-selected")) === "true", "End 到末行并同步选择");
  await amPress("Home");
  check((await amActive()) === amOrder[0] && (await amAria(amOrder[0], "aria-selected")) === "true", "Home 回首行并同步选择");
  await click(await rowAt(amOrder[1]), MOD.shift);
  await settle();
  var amMulti = await ev(`[...document.querySelectorAll('#ed-tree .ed-node')].filter((n) => n.getAttribute('aria-selected') === 'true').map((n) => n.dataset.id)`);
  check(amMulti.length === 2 && amMulti.includes(amOrder[0]) && amMulti.includes(amOrder[1]), `⇧ 多选没被无障碍改动吃掉：两行同时 aria-selected（${json(amMulti)}）`);
  await clickSel("#ly-group");
  await settle();
  await waitFor(`!!document.querySelector('#ed-tree .ed-node[aria-expanded]')`, 15000);
  var amGroup = await ev(`(document.querySelector('#ed-tree .ed-node[aria-expanded]') || {}).dataset?.id || null`);
  check(!!amGroup && (await amAria(amGroup, "aria-level")) === "1" && (await ev(`[...document.querySelectorAll('#ed-tree .ed-node')].filter((n) => n.getAttribute('aria-level') === '2').length`)) === 2, "成组后：组是 aria-level=1，两个子层是 aria-level=2");
  await amFocusRow(amGroup);
  await amPress("ArrowLeft");
  check((await amAria(amGroup, "aria-expanded")) === "false" && (await amActive()) === amGroup, "← 折叠组（aria-expanded=false，焦点留在组上）");
  await amPress("ArrowRight");
  check((await amAria(amGroup, "aria-expanded")) === "true", "→ 展开组（aria-expanded=true）");
  await amPress("ArrowRight");
  var amChild = await ev(`(document.querySelector('#ed-tree .ed-node[aria-level="2"]') || {}).dataset?.id || null`);
  check(!!amChild && (await amActive()) === amChild && (await amAria(amChild, "aria-selected")) === "true", "→ 在展开的组上进第一个子行并同步选择");
  await amPress("ArrowLeft");
  check((await amActive()) === amGroup, "← 从子行回到组行");
  check(await ev(`document.activeElement.closest('#ed-tree') !== null`), "焦点始终留在图层树里（没有跑到别的面板）");

  // ── B8：脚本事件模板（面板入口 → 8 类 → 生成的脚本一次预检通过） ──
  await clickRow(amB);
  await settle();
  var amTpls = await ev(`[...document.querySelectorAll('#script-template option')].map((o) => [o.value, o.textContent])`);
  check(json(amTpls.map((o) => o[0])) === json(["update", "init", "applyUserProperties", "cursor", "media", "resizeScreen", "animationEvent", "destroy"]), `脚本面板给出 8 类生命周期模板（${json(amTpls.map((o) => o[0]))}）`);
  check(amTpls.length === 8 && !amTpls[0][1].startsWith("sc.") && amTpls[0][1].includes("update"), `模板下拉是本地化文案（首项「${amTpls[0][1]}」）`);
  await ev(`(() => { const s = document.querySelector('#script-template'); s.value = 'cursor'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await ev(`(() => { const s = document.querySelector('#script-add'); s.value = 'text'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await waitFor(`!!document.querySelector('.ed-script-src')`, 15000);
  await settle();
  var amSrc = await ev(`document.querySelector('.ed-script-src').value`);
  check(/export function update\(value\)/.test(amSrc) && /export function cursorClick\(e\) \{\}/.test(amSrc) && /export function cursorMove\(e\) \{\}/.test(amSrc), "cursor 模板生成的脚本 = 6 个 cursor* 钩子 + 字段主回调 update");
  check(/cursorClick/.test(amSrc) && !/mediaLyricsChanged/.test(amSrc) && !/animationEvent/.test(amSrc), "只放选中的那一类生命周期（没有把 8 类全塞进去）");
  await waitFor(`/语法正确|Syntax OK/.test((document.querySelector('.ed-script-status') || {}).textContent || '')`, 15000);
  var amStatus = await ev(`(document.querySelector('.ed-script-status') || {}).textContent || ''`);
  check(/cursorMove/.test(amStatus), `预检状态栏列出引擎认到的入口（「${amStatus}」）`);
  check((await h.errorLines()).length === 0, "M9 命令面板 / 无障碍 / 脚本模板全程无错误");

  // ── M10 D1 回归：槽位里的插件贡献不许被宿主重绘清扫 ──
  // 背景：`renderExportMenu()` 原先用后代查询清扫 `button`，会把 `#ed-plugin-export`
  // 里的插件贡献一并删掉（注册表还在、贡献没了），而且切语言 / 新增导出器时反复复现。
  } catch (err) { await hlAbort("AM", "AM. M9 命令面板 / 无障碍 / 脚本事件模板", err); }
  section("AN. M10 插件槽位：导出菜单重绘不清扫插件项");
  if (hlState.dead) hlSkip("AN", "AN. M10 插件槽位：导出菜单重绘不清扫插件项"); else try {
  await gotoEditor();
  await newBlank("#000000");
  var anInject = () =>
    ev(`(() => {
      const host = document.querySelector('#ed-plugin-export');
      if (!host) return 'no-slot';
      let b = host.querySelector('#an-plugin-item');
      if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'an-plugin-item'; host.appendChild(b); }
      host.hidden = false;
      return 'an-plugin-item';
    })()`);
  check((await anInject()) === "an-plugin-item", "AN 插件导出槽位存在（#ed-plugin-export 可挂条目）");
  var anLang = async (v) => {
    await ev(`(() => { const s = document.querySelector('#lang'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await settle();
  };
  await anLang("en");
  check(
    (await ev(`!!document.querySelector('#ed-plugin-export #an-plugin-item')`)) === true,
    "★ AN 切语言重绘导出菜单后插件贡献仍在（宿主只清扫 `:scope > button`）",
  );
  await anLang("zh");
  check(
    (await ev(`!!document.querySelector('#ed-plugin-export #an-plugin-item')`)) === true,
    "★ AN 连续两次重绘都不动插件项（贡献不会静默消失）",
  );
  // 反向：宿主自己的导出项仍按注册表重建（收窄清扫范围没有把自愈弄丢）
  var anDel = await ev(`(() => { const b = document.querySelector('#export-zip'); if (!b) return false; b.remove(); return true; })()`);
  await anLang("en");
  check(
    anDel === true && (await ev(`!!document.querySelector('#export-zip')`)) === true,
    "AN 删掉宿主自己的导出项后重绘会补回来（清扫范围收窄不影响自愈）",
  );
  check((await h.errorLines()).length === 0, "M10 插件槽位重绘 / 语言切换全程无错误");
  } catch (err) { await hlAbort("AN", "AN. M10 插件槽位：导出菜单重绘不清扫插件项", err); }

/**
 * AO. 操控变形（Puppet Warp，伪 Live2D）：图片层 → 转木偶 → 拖钉子形变 → 记录关键帧 → 烘焙 →
 * 存库重开。判据全是 CDP 截图的真实像素 + 盘上 .mdl（用引擎自己的 mdl-parse 读回来）。
 */
async function warpE2E() {
  section("AO. 操控变形端到端（图片层 → 转木偶 → 拖钉子 → 记录关键帧 → 烘焙 → 存库重开）");
  if (hlState.dead) hlSkip("AO", "AO. 操控变形端到端（图片层 → 转木偶 → 拖钉子 → 记录关键帧 → 烘焙 → 存库重开）"); else try {
  var parseMDL = (await imp("renderer/vendor/we-scene/render/mdl-parse.js")).parseMDL;
  var aoPins = () => ev(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length`);
  var aoDisabled = async (cls) => {
    const r = await ev(`(() => { const b = document.querySelector('${cls}'); return b ? b.disabled : 'MISSING'; })()`);
    if (r === "MISSING") throw new Error(`AO 探针：页面里没有 ${cls}（面板没到该状态）`);
    return r;
  };
  /** 播放头回到 0：记录关键帧落在第 0 帧（重挂保持时刻，画面判据才确定） */
  var aoSeek = (t) =>
    ev(`(() => { const r = document.querySelector('#tl-range'); r.value = '${t}'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  /** 盘上「stripe」层的模型 json（+ 目录 / 场景对象） */
  var aoDisk = (id) => {
    const dir = path.join(lib, id);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
    const obj = (sc.objects ?? []).find((o) => o.name === "stripe") ?? (sc.objects ?? [])[0];
    return { dir, sc, obj, json: obj ? JSON.parse(fs.readFileSync(path.join(dir, String(obj.image)), "utf8")) : null };
  };
  /** 绑定姿势：模型 json 的 warp 布局 + 图片尺寸 ⇒ 钉 i（骨 i+1）的局部平移（原点在图片中心、Y 向上） */
  var aoBindOf = (json, bone) => {
    const p = json.warp.pins[bone - 1];
    return [(p[0] - 0.5) * json.width, (0.5 - p[1]) * json.height];
  };
  /** 画布缩放：世界单位 → 屏幕 CSS 像素（编辑器按长边适配） */
  var aoScale = (cr) => Math.max(cr.w / 1920, cr.h / 1080);

  await gotoEditor();
  await clearLocalStore();
  await gotoEditor();
  await newBlank(BG);
  await addImage(stripePath);
  var aoCr = await h.canvasRect();
  // 400×200 的图居中（origin 960,540 / scale 1）⇒ 世界 760..1160 × 440..640，上半红下半蓝
  var aoIn = worldToPage(aoCr, [960, 590]);
  var aoLow = worldToPage(aoCr, [960, 490]);
  var aoFar = worldToPage(aoCr, [300, 500]);
  var aoLeft = worldToPage(aoCr, [700, 600]); // 左边缘外 60px
  var aoLeftLow = worldToPage(aoCr, [700, 480]);
  var aoRight = worldToPage(aoCr, [1210, 450]); // 右边缘外 50px
  var cIn = await pixelAt(aoIn);
  var cLow = await pixelAt(aoLow);
  var cFar = await pixelAt(aoFar);
  check(isRed(cIn) && isBlue(cLow) && close(cFar, BG_RGB, 10), `底图：上红下蓝、外面背景色（${cIn} / ${cLow} / ${cFar}）`);
  check((await ev(`!!document.querySelector('.ed-warp .ed-warp-make')`)) === true, "普通图片层的检视器里就有「操控变形」分组（不用先收过 modelForm）");
  check(close(await pixelAt(aoLeft), BG_RGB, 10) && close(await pixelAt(aoRight), BG_RGB, 10), "左右边缘外都还是背景色（形变判据的起点）");

  // ── 转木偶：三件套落盘 + 改指向（origin / scale / 角度 / 尺寸照旧 ⇒ 画面逐像素不变） ──
  var aoRc = await h.readyCount();
  await clickSel(".ed-warp-make");
  await h.waitRemount(aoRc);
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 40000);
  aoCr = await h.canvasRect();
  var cIn2 = await pixelAt(aoIn);
  var cLow2 = await pixelAt(aoLow);
  var cFar2 = await pixelAt(aoFar);
  check(close(cIn2, cIn, 8) && close(cLow2, cLow, 8) && close(cFar2, cFar, 8), `转木偶后画面逐像素不变（上 ${cIn}→${cIn2} / 下 ${cLow}→${cLow2} / 外 ${cFar}→${cFar2}）`);
  check((await aoPins()) === 9, "默认 3×3 = 9 根钉子，转换后自动进入操控变形");
  check(/操控变形|Puppet Warp/.test(await ev(`document.querySelector('.ed-warp .ed-insp-title').textContent`)), "分组标题本地化");
  check((await aoDisabled(".ed-warp-record")) === true && (await aoDisabled(".ed-warp-bake")) === true, "还没拖过钉子：记录关键帧 / 烘焙都点不动");

  // ── 撤销 / 重做转换：图层形态来回切，分组跟着切 ──
  aoRc = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(aoRc);
  check((await ev(`!!document.querySelector('.ed-warp .ed-warp-make')`)) === true && (await aoPins()) === 0 && close(await pixelAt(aoIn), cIn, 8),
    "撤销转换：层回到普通图片（分组回到「转为木偶」、钉子清空），画面照旧");
  aoRc = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(aoRc);
  await waitFor(`!!document.querySelector('.ed-warp .ed-warp-open')`, 40000);
  check((await ev(`!!document.querySelector('.ed-warp .ed-warp-open')`)) === true, "重做转换：层又是操控变形木偶（重挂后停在「进入操控变形」）");
  await clickSel(".ed-warp-open");
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 40000);
  check((await aoPins()) === 9, "点「进入操控变形」：9 根钉子回来");

  // ── 网格密度：重建骨架（顶点按偏移场重采样，形变 / 画面都不该跳） ──
  aoRc = await h.readyCount();
  await ev(`(() => { const s = document.querySelector('#ed-inspector .ed-warp-grid'); s.value = '24'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await h.waitRemount(aoRc);
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 40000);
  check((await ev(`document.querySelector('#ed-inspector .ed-warp-grid').value`)) === "24" && (await aoPins()) === 9, "改网格密度：重建骨架后密度写回、仍停在操控变形");
  aoCr = await h.canvasRect();
  check(close(await pixelAt(aoIn), cIn, 10) && close(await pixelAt(aoLow), cLow, 10), "重建网格后画面仍逐像素不变（顶点只是重采样）");

  // ── 拖左上角钉子：把图往左拉出去（IDW：近处跟着走，远处不动） ──
  var aoPin0 = worldToPage(aoCr, [760, 640]);
  await drag(aoPin0, [aoPin0[0] - 70, aoPin0[1]]);
  var cLeft = await pixelAt(aoLeft);
  check(isRed(cLeft), `拖左上角钉子向左：图片被拉过去盖住那块（${cLeft}）`);
  check(isBlue(await pixelAt(aoLow)) && close(await pixelAt(aoFar), BG_RGB, 10) && close(await pixelAt(aoLeftLow), BG_RGB, 10),
    "同一时刻：图内下半 / 远处 / 左下都不动（钉子只带近处，衰减是局部的）");
  check((await aoDisabled(".ed-warp-record")) === false, "拖过钉子后「记录关键帧」可点");

  // ── 记录关键帧：写进 .mdl 轨道 → 重挂后自动回到操控变形，画面仍是形变后的样子 ──
  await aoSeek(0);
  await waitFor(`document.querySelector('#tl-time').textContent === '0.00s'`, 20000);
  aoRc = await h.readyCount();
  await clickSel(".ed-warp-record");
  await h.waitRemount(aoRc);
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 60000);
  check(close(await pixelAt(aoLeft), cLeft, 20), "记录关键帧后画面照旧（姿势进了 .mdl 轨道，不是只在内存里）");
  check((await aoDisabled(".ed-warp-record")) === true, "记录后未记录的位移清零（要再拖一次才可再记）");

  // ── 盘上产物：模型 json 的 warp 布局 / .mdl 骨架与轨道 / 源图归属 ──
  var aoId1 = await saveLoose();
  var aoD1 = aoDisk(aoId1);
  check(
    aoD1.json?.warp?.v === 1 && aoD1.json.warp.pins.length === 9 && aoD1.json.warp.cols === 24 && aoD1.json.warp.rows === 12 && aoD1.json.warp.power === 4,
    `盘上模型 json 记着钉子布局（${JSON.stringify(aoD1.json?.warp)}）`,
  );
  check(typeof aoD1.json.puppet === "string" && fs.existsSync(path.join(aoD1.dir, aoD1.json.puppet)), "模型 json 指向 .mdl（puppet 三件套齐全）");
  check(Buffer.compare(fs.readFileSync(path.join(aoD1.dir, "materials/editor/stripe.png")), fs.readFileSync(stripePath)) === 0,
    "源图仍是逐字节原图（换了指向后靠 assets.share 跟着新木偶留下，没成孤儿）");
  var aoM1 = parseMDL(new Uint8Array(fs.readFileSync(path.join(aoD1.dir, aoD1.json.puppet))));
  check(aoM1.bones.length === 10 && aoM1.bones[0].parent === -1 && aoM1.bones.slice(1).every((b) => b.parent === 0),
    `骨架 = 根骨 + 9 根钉骨（${aoM1.bones.length} 根，钉骨都挂在根骨下）`);
  var aoAn1 = aoM1.animations[0];
  // 轨道是**绝对骨局部 TRS**：没拖过的帧 / 骨都等于绑定姿势（不是 0），所以要拿绑定姿势当基线
  var aoB1 = aoBindOf(aoD1.json, 1);
  var aoB9 = aoBindOf(aoD1.json, 9);
  var aoFrames = [];
  for (let f = 0; f <= aoAn1.frameCount; f++) {
    const o = f * 9;
    if (Math.abs(aoAn1.tracks[1].keyframes[o] - aoB1[0]) > 1 || Math.abs(aoAn1.tracks[1].keyframes[o + 1] - aoB1[1]) > 1) aoFrames.push(f);
  }
  check(aoAn1.name === "warp" && aoAn1.fps === 30 && aoAn1.frameCount === 30 && aoAn1.tracks.length === 10,
    `片段「${aoAn1.name}」：fps ${aoAn1.fps} / ${aoAn1.frameCount + 1} 帧 / 每根骨一条轨道`);
  // loop 片段记账时会保持首末一致：记录落在播放头那帧，收尾帧跟着写成同一个值，其它帧一律不动
  check(
    aoFrames.includes(0) &&
      aoFrames.every((f) => f === 0 || f === aoAn1.frameCount) &&
      Math.abs(aoAn1.tracks[1].keyframes[aoAn1.frameCount * 9] - aoAn1.tracks[1].keyframes[0]) < 1e-4 &&
      Math.abs(aoAn1.tracks[1].keyframes[9] - aoB1[0]) < 1e-4,
    `记录只落在播放头那帧（第 ${aoFrames.join(",")} 帧，位移 ${(aoAn1.tracks[1].keyframes[0] - aoB1[0]).toFixed(1)},${(aoAn1.tracks[1].keyframes[1] - aoB1[1]).toFixed(1)} px；收尾帧按 loop 保持首末一致，中间帧不动）`,
  );
  var aoK1 = aoScale(aoCr);
  check(
    Math.abs(aoAn1.tracks[1].keyframes[0] - aoB1[0] + 70 / aoK1) < 8 && Math.abs(aoAn1.tracks[1].keyframes[1] - aoB1[1]) < 1,
    `记录的位移 = 屏幕拖了 70px ÷ 画布缩放 ${aoK1.toFixed(3)}（${(aoAn1.tracks[1].keyframes[0] - aoB1[0]).toFixed(1)} px，只有 x 分量）`,
  );
  check(close([aoAn1.tracks[9].keyframes[0], aoAn1.tracks[9].keyframes[1]], aoB9, 1e-3), "没拖过的钉骨轨道仍是绑定姿势（不写无关位移）");

  // ── 烘焙：把当前预览位移吃进顶点，画面不跳、轨道不动 ──
  var aoPin8 = worldToPage(aoCr, [1160, 440]);
  await drag(aoPin8, [aoPin8[0] + 70, aoPin8[1]]);
  var cRight = await pixelAt(aoRight);
  check(isBlue(cRight), `拖右下角钉子向右：图片被拉出去（${cRight}）`);
  aoRc = await h.readyCount();
  await clickSel(".ed-warp-bake");
  await h.waitRemount(aoRc);
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 60000);
  check(close(await pixelAt(aoRight), cRight, 20), "烘焙后画面不跳（形变从预览换成顶点，看到的还是同一个形状）");
  check((await aoDisabled(".ed-warp-record")) === true, "烘焙后没有未记录的位移");
  check(close(await pixelAt(aoLeft), cLeft, 40), "先前记录的那一帧也还在（烘焙只吃预览位移，不动轨道）");
  var aoId2 = await saveLoose();
  var aoD2 = aoDisk(aoId2);
  check(!!aoD2.json && String(aoD2.obj.image) !== String(aoD1.obj.image), `烘焙写了新的模型副本（${aoD2.obj.image}）`);
  var aoM2 = parseMDL(new Uint8Array(fs.readFileSync(path.join(aoD2.dir, aoD2.json.puppet))));
  check(aoM2.bounds.maxX > aoM1.bounds.maxX + 10, `顶点真被拉出去了（maxX ${aoM1.bounds.maxX.toFixed(1)} → ${aoM2.bounds.maxX.toFixed(1)}）`);
  var aoB9b = aoBindOf(aoD2.json, 9);
  var aoB1b = aoBindOf(aoD2.json, 1);
  check(close([aoM2.animations[0].tracks[9].keyframes[0], aoM2.animations[0].tracks[9].keyframes[1]], aoB9b, 1e-3),
    "烘焙不写轨道：第 9 根钉骨仍是绑定姿势（位移全在顶点里）");
  var aoKeep = [aoM2.animations[0].tracks[1].keyframes[0] - aoB1b[0], aoM2.animations[0].tracks[1].keyframes[1] - aoB1b[1]];
  check(
    aoKeep[0] > -180 && aoKeep[0] < -160 && Math.abs(aoKeep[1]) < 1,
    `烘焙重建 .mdl 时把已记录的关键帧原样带走（第 0 帧位移 ${aoKeep[0].toFixed(1)},${aoKeep[1].toFixed(1)} px）`,
  );
  check(aoD2.json.warp?.pins.length === 9 && aoD2.json.warp.cols === 24, "烘焙后的模型 json 照旧带着钉子布局（接着调）");
  check(Buffer.compare(fs.readFileSync(path.join(aoD2.dir, "materials/editor/stripe.png")), fs.readFileSync(stripePath)) === 0, "新副本也把源图带在名下");

  // ── 存库重开：形变与钉子布局都要回来，而且还能接着编辑 ──
  await reopen(aoId2);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(`/首帧就绪|First frame ready/.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('.ed-warp .ed-warp-open')`, 40000);
  aoCr = await h.canvasRect();
  var cRight3 = await pixelAt(aoRight);
  var cLeft3 = await pixelAt(aoLeft);
  check(isBlue(cRight3) && isRed(cLeft3), `重开后烘焙过的形变还在（右 ${cRight3} / 左 ${cLeft3}）`);
  check((await ev(`!!document.querySelector('.ed-warp .ed-warp-open')`)) === true, "重开后仍是操控变形木偶（warp 布局从模型 json 读回来）");
  await clickSel(".ed-warp-open");
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 40000);
  check((await aoPins()) === 9, "重开后能再次进入操控变形，9 根钉子都在");
  var aoPin8b = worldToPage(aoCr, [1160, 440]);
  await drag(aoPin8b, [aoPin8b[0] + 40, aoPin8b[1]]);
  check((await aoDisabled(".ed-warp-record")) === false, "重开后拖钉子照常预览 / 记录（还能接着调）");

  // ── 竖直向下拖钉子：屏幕向下 = 模型 −Y（横向拖测不出 y 轴符号） ──
  var aoPin6 = worldToPage(aoCr, [760, 440]); // 左下角钉子（pin 6：u=0, v=1）
  var aoK3 = aoScale(aoCr);
  await drag(aoPin6, [aoPin6[0], aoPin6[1] + 40]);
  aoRc = await h.readyCount();
  await clickSel(".ed-warp-record");
  await h.waitRemount(aoRc);
  await waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 60000);
  var aoId3 = await saveLoose();
  var aoD3 = aoDisk(aoId3);
  var aoM3 = parseMDL(new Uint8Array(fs.readFileSync(path.join(aoD3.dir, aoD3.json.puppet))));
  var aoB7 = aoBindOf(aoD3.json, 7);
  var aoDx7 = aoM3.animations[0].tracks[7].keyframes[0] - aoB7[0];
  var aoDy7 = aoM3.animations[0].tracks[7].keyframes[1] - aoB7[1];
  check(
    aoDy7 < -20 && Math.abs(aoDx7) < 8 && Math.abs(aoDy7 + 40 / aoK3) < 12,
    `竖直拖钉子：屏幕向下 40px = 模型 −Y（Δ ${aoDx7.toFixed(1)},${aoDy7.toFixed(1)}，期望 ≈ 0,−${(40 / aoK3).toFixed(1)}）`,
  );
  check(
    Math.abs(aoD3.json.width - 400) < 1e-6 && Math.abs(aoD3.json.height - 200) < 1e-6,
    "烘焙过的模型 json 仍记着图片尺寸（绑定姿势基线的来源）",
  );

  var aoErrs = await h.errorLines();
  check(aoErrs.length === 0, `操控变形全程控制台无错误${aoErrs.length ? `：${aoErrs.slice(0, 2).join(" / ")}` : ""}`);
  } catch (err) { await hlAbort("AO", "AO. 操控变形端到端（图片层 → 转木偶 → 拖钉子 → 记录关键帧 → 烘焙 → 存库重开）", err); }
}

await warpE2E();

/**
 * AP. 几何与角色表（P1）：网格生成 / 细分 / Padding / 切片 / 拓扑 / Lock / 自动抠图 / 涂抹 / 应用部件 / 重开。
 * 判据 = CDP 截图的真实像素（叠加层线框、角色表视图）+ 盘上 .mdl（引擎自己的 mdl-parse 读回）。
 */
async function geomE2E() {
  var apName = "AP. 几何与角色表（P1：网格 → 细分 → Padding → 切片 → 拓扑 → 抠图 → 应用部件 → 重开）";
  section(apName);
  if (hlState.dead) hlSkip("AP", apName); else try {
  var parseMDL = (await imp("renderer/vendor/we-scene/render/mdl-parse.js")).parseMDL;
  /** 盘上「stripe」层的模型 json（+ 目录 / 场景对象），与 AO 段同法 */
  var apDisk = (id) => {
    const dir = path.join(lib, id);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
    const obj = (sc.objects ?? []).find((o) => o.name === "stripe") ?? (sc.objects ?? [])[0];
    return { dir, sc, obj, json: obj ? JSON.parse(fs.readFileSync(path.join(dir, String(obj.image)), "utf8")) : null };
  };
  var apMdl = (d) => parseMDL(new Uint8Array(fs.readFileSync(path.join(d.dir, d.json.puppet))));
  var apEl = (sel) => `document.querySelector('#ed-inspector ${sel}')`;
  var apHas = async (sel) => (await ev(`!!document.querySelector('${sel}')`)) === true;
  var apVal = (sel) => ev(`(() => { const el = ${apEl(sel)}; return el ? String(el.value) : null; })()`);
  var apSet = (sel, v) => ev(`(() => { const el = ${apEl(sel)}; if (!el) return false; el.value = '${v}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var apToggle = (sel, on) => ev(`(() => { const el = ${apEl(sel)}; if (!el) return false; el.checked = ${on ? "true" : "false"}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var apPick = (sel, v) => ev(`(() => { const el = ${apEl(sel)}; if (!el) return false; el.value = '${v}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var apDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  /** #ed-overlay 叠加层画布上该页面坐标附近 n×n 里 alpha 最大的像素（1px 细线用 4×4 合成均值会被稀释掉；格内判据用 n=1） */
  var apOverlay = (pt, n = 5) => ev(`(() => {
    const cv = document.querySelector('#ed-overlay');
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const x = Math.round((${pt[0]} - r.left) * k);
    const y = Math.round((${pt[1]} - r.top) * k);
    const h = ${n} >> 1;
    const d = cv.getContext('2d').getImageData(x - h, y - h, ${n}, ${n}).data;
    let best = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > best[3]) best = [d[i], d[i + 1], d[i + 2], d[i + 3]];
    return best;
  })()`);
  var apPins = () => waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 60000);
  /** 第一块 limb 的掩码像素数（行文本是「名字 · 像素数」） */
  var apLimbPx = () => ev(`(() => { const el = document.querySelectorAll('.ed-sheet-limbs .ed-fx-name')[0]; if (!el) return -1; return Number(String(el.textContent).split('·').pop().trim()); })()`);
  /** 当前选中（`.is-on`）那块 limb 的掩码像素数 */
  var apActivePx = () => ev(`(() => { const el = document.querySelector('.ed-sheet-limbs .ed-sheet-limb.is-on .ed-fx-name'); if (!el) return -1; return Number(String(el.textContent).split('·').pop().trim()); })()`);
  /** 检视器改一个值 → 等写盘重挂（warpEnter 会按新几何重建会话） */
  var apEdit = async (sel, v) => {
    const rc = await h.readyCount();
    if (!(await apSet(sel, v))) throw new Error(`AP 探针：检视器里没有 ${sel}`);
    await h.waitRemount(rc);
    await apPins();
    return h.canvasRect();
  };
  var apToggleEdit = async (sel, on) => {
    const rc = await h.readyCount();
    if (!(await apToggle(sel, on))) throw new Error(`AP 探针：检视器里没有 ${sel}`);
    await h.waitRemount(rc);
    await apPins();
    return h.canvasRect();
  };
  /** 画布上点一下（切片待命 / 翻格子）→ 等写盘重挂 */
  var apStageWrite = async (pt) => {
    const rc = await h.readyCount();
    await click(pt);
    await h.waitRemount(rc);
    await apPins();
    return h.canvasRect();
  };

  await gotoEditor();
  await clearLocalStore();
  await gotoEditor();
  await newBlank(BG);
  await addImage(stripePath);
  var apRc = await h.readyCount();
  await clickSel(".ed-warp-make");
  await h.waitRemount(apRc);
  await apPins();
  var apCr = await h.canvasRect();

  // ── 面板与默认密度：400×200 的图，默认基础网格 = 长边 32 格（12.5px 格） ──
  check((await apHas(".ed-geom .ed-geom-view")) && (await apHas(".ed-sheet .ed-sheet-load")), "转木偶后几何 / 角色表两个分组都出现（P1）");
  check(/几何|Geometry/.test(await ev(`document.querySelector('.ed-geom .ed-insp-title').textContent`)), "几何分组标题本地化");
  check(/角色表|Character Sheet/.test(await ev(`document.querySelector('.ed-sheet .ed-insp-title').textContent`)), "角色表分组标题本地化");
  var apCols0 = await apVal(".ed-geom-cols");
  var apRows0 = await apVal(".ed-geom-rows");
  check(apCols0 === "32" && apRows0 === "16", `默认基础网格 = 长边 32 格（${apCols0}×${apRows0}）`);

  // ── 显示网格：叠加层画布上网格线是暗线；黄色只留给手动切片（细线按叠加层 alpha 判，4×4 合成均值太稀） ──
  var apNode = worldToPage(apCr, [960, 590]); // 12.5px 格的交点（格子边界，且离最近的钉子 50px）
  var apCell = worldToPage(apCr, [966.25, 596.25]); // 格内（离最近的线 6.25 世界 px）
  var apCut = worldToPage(apCr, [840, 596.25]); // 之后要切的那一刀的位置（20%），y 取格内、避开暗线
  check((await apOverlay(apNode))[3] === 0, "还没开「显示网格」：叠加层上没有线");
  var apCrV0 = apCr;
  await clickSel(".ed-geom-view");
  await waitFor(`document.querySelector('#ed-inspector .ed-geom-view').dataset.et === 'geo.viewOn'`, 20000);
  var apCrV1 = await h.canvasRect();
  check(apCrV0.x === apCrV1.x && apCrV0.y === apCrV1.y && apCrV0.w === apCrV1.w && apCrV0.h === apCrV1.h,
    `开「显示网格」不动画布布局（${JSON.stringify(apCrV0)} → ${JSON.stringify(apCrV1)}）`);
  var oLine = await apOverlay(apNode);
  check(oLine[3] > 30 && oLine[0] < 60 && oLine[1] < 60, `开「显示网格」：网格线是暗线（叠加层像素 ${oLine}）`);
  var oCell = await apOverlay(apCell, 1);
  check(oCell[3] < 30, `开「显示网格」：格内不画线（格心叠加层像素 ${oCell}）`);
  // n=1：32×16 的格子在页面上只有 5.1 CSS px、格心离最近的线才 2.55 px，n=5 的窗口会罩到暗线
  var oNoSlice = await apOverlay(apCut, 1);
  check(oNoSlice[3] === 0, `基础网格的切线（32×16 格共 45 条）不画黄线，只有手动切片才黄（切点像素 ${oNoSlice}）`);

  // ── 细分 2：32×16 → 64×32 格（65×33 顶点 / 64×32×6 索引） ──
  apCr = await apEdit(".ed-geom-sub", 2);
  check((await apVal(".ed-geom-cols")) === "32" && (await apVal(".ed-geom-sub")) === "2", "细分写回面板：基础格数不变、每格再切 2");
  var apIdA = await saveLoose();
  var dA = apDisk(apIdA);
  var mA = apMdl(dA);
  check(mA.vertexCount === 2145 && mA.indexCount === 64 * 32 * 6, `细分 2 进了 .mdl：${mA.vertexCount} 顶点 / ${mA.indexCount} 索引（期望 2145 / ${64 * 32 * 6}）`);
  check(
    dA.json?.puppetWarp?.geometry?.subdivision === 2 &&
      dA.json.puppetWarp.geometry.cols === 32 && dA.json.puppetWarp.geometry.rows === 16 &&
      dA.json.puppetWarp.warp.v === 1 && dA.json.puppetWarp.warp.cols <= 48 && dA.json.puppetWarp.warp.rows <= 48,
    `盘上记着细分与基础密度（sub ${dA.json?.puppetWarp?.geometry?.subdivision} / 基础 ${dA.json?.puppetWarp?.geometry?.cols}×${dA.json?.puppetWarp?.geometry?.rows}；v1 钉子布局 cols ${dA.json?.puppetWarp?.warp?.cols}×${dA.json?.puppetWarp?.warp?.rows} 留在 48 以内，细分后的 64×32 只由 geometry 表达）`,
  );

  // ── Padding 40：网格轮廓四边外扩 40px、UV 出界；模型尺寸与 cropoffset 都不动 ──
  apCr = await apEdit(".ed-geom-pad", 40);
  var dB = apDisk(await saveLoose());
  var mB = apMdl(dB);
  check(
    Math.abs(mB.bounds.minX + 240) < 1.5 && Math.abs(mB.bounds.maxX - 240) < 1.5 && Math.abs(mB.bounds.minY + 140) < 1.5 && Math.abs(mB.bounds.maxY - 140) < 1.5,
    `Padding 40：网格外扩到 x ${mB.bounds.minX.toFixed(1)}..${mB.bounds.maxX.toFixed(1)} / y ${mB.bounds.minY.toFixed(1)}..${mB.bounds.maxY.toFixed(1)}（期望 ±240 / ±140）`,
  );
  var apU0 = 1;
  var apU1 = 0;
  for (let i = 0; i < mB.uvs.length; i += 2) {
    if (mB.uvs[i] < apU0) apU0 = mB.uvs[i];
    if (mB.uvs[i] > apU1) apU1 = mB.uvs[i];
  }
  check(apU0 < -0.05 && apU1 > 1.05, `Padding 把 UV 拉到图外（${apU0.toFixed(3)}..${apU1.toFixed(3)}，出界靠 clamp 重复边缘）`);
  check(dB.json.width === 400 && dB.json.height === 200 && !("cropoffset" in dB.json), "Padding 只动网格：模型 width / height 不变、不新增 cropoffset（cropoffset 语义未定，P1 不碰）");

  // ── 切片：点「加纵向切片」（按钮亮起待命）再点画布 20% 处 ──
  await clickSel(".ed-geom-slice-x");
  check((await ev(`document.querySelector('#ed-inspector .ed-geom-slice-x').classList.contains('is-arm')`)) === true, "「加纵向切片」进入待命态（按钮高亮）");
  apCr = await apStageWrite(worldToPage(apCr, [840, 590])); // 图内 x=80 → 20%
  var dC = apDisk(await saveLoose());
  var mC = apMdl(dC);
  var apSl = dC.json?.puppetWarp?.geometry?.sliceX ?? [];
  check(apSl.length === 1 && Math.abs(apSl[0] - 0.2) < 0.01, `切在 20% 处：盘上 geometry.sliceX = ${JSON.stringify(apSl)}`);
  check(mC.vertexCount > mA.vertexCount, `切片给基础网格多切了一刀（顶点 ${mA.vertexCount} → ${mC.vertexCount}）`);
  // 几何组里有两个 note：上面是网格摘要，下面是切片计数
  check(/纵向 1 条|1 vertical/.test(await ev(`document.querySelectorAll('#ed-inspector .ed-geom .ed-note')[1].textContent`)), "面板切片计数 = 1（基础网格的细分不算切片）");
  check((await ev(`document.querySelector('#ed-inspector .ed-geom-slice-x').classList.contains('is-arm')`)) === false, "落刀后解除待命态（不会一直吃掉下一次点击）");
  apCut = worldToPage(apCr, [840, 590]); // 重挂后面布框可能变，重新算页面坐标（切在竖直线上，可能压在暗线之上）
  var oSlice = await apOverlay(apCut);
  check(oSlice[3] > 80 && oSlice[0] > 120 && oSlice[0] > oSlice[2] + 60 && oSlice[1] > oSlice[2],
    `切片线画在 20% 处（叠加层像素 ${oSlice}，黄色；暗线是 0,0,0,67 不会误判）`);

  // ── Edit Topology：点一格翻对角线 ──
  await clickSel(".ed-geom-topo");
  check((await ev(`document.querySelector('#ed-inspector .ed-geom-topo').dataset.et`)) === "geo.topoOn", "「编辑拓扑」进入翻转态");
  apCr = await apStageWrite(worldToPage(apCr, [966.25, 596.25]));
  var dD = apDisk(await saveLoose());
  var apFlips = dD.json?.puppetWarp?.geometry?.topology?.flips ?? [];
  check(apFlips.length === 1, `点一格：盘上 topology.flips = ${JSON.stringify(apFlips)}`);
  await clickSel(".ed-geom-topo");

  // ── Lock geometry ──
  apCr = await apToggleEdit(".ed-geom-lock", true);
  var dE = apDisk(await saveLoose());
  check(dE.json?.puppetWarp?.geometry?.locked === true, "Lock geometry 落盘（puppetWarp.geometry.locked = true）");

  // ── 角色表：载入原图 → 自动抠图 ──
  check((await ev(`!!document.querySelector('#ed-inspector .ed-sheet-load') && document.querySelector('#ed-inspector .ed-sheet-load').disabled === false`)) === true,
    "角色表：载入按钮可用（层没被锁）");
  var apTexRow = await ev(`(() => { const g = [...document.querySelectorAll('#ed-inspector .ed-insp-group')].find((d) => /贴图|Texture/.test(d.querySelector('.ed-insp-title')?.textContent || '')); return g ? g.innerText.replace(/\\n/g, ' / ') : '(没有贴图分组)'; })()`);
  await clickSel(".ed-sheet-load");
  var apSheetOk = await waitFor(`!!document.querySelector('.ed-sheet .ed-sheet-auto')`, 30000).then(() => true, () => false);
  if (!apSheetOk) {
    var apLogTail = await ev(`[...document.querySelectorAll('#ed-con-body > div')].slice(-5).map((d) => d.textContent).join(' ⏎ ')`);
    var apErrsNow = await h.errorLines();
    check(false, `角色表载入没成：贴图槽「${apTexRow}」/ 日志「${apLogTail}」/ 页面错误 ${JSON.stringify(apErrsNow)}`);
  }
  var apThr = Number(await apVal(".ed-sheet-threshold"));
  check((await apHas("#ed-inspector .ed-sheet-threshold")) && Number.isFinite(apThr) && apThr >= 0 && apThr <= 255, `角色表载入原图 400×200（阈值 ${apThr} / 质量 ${await apVal(".ed-sheet-quality")}）`);
  check((await ev(`document.querySelectorAll('.ed-sheet-limbs .ed-fx-item').length`)) === 0, "还没抠图：limb 列表是空的");
  await clickSel(".ed-sheet-auto");
  await waitFor(`document.querySelectorAll('.ed-sheet-limbs .ed-fx-item').length >= 1`, 30000);
  var apNLimb = await ev(`document.querySelectorAll('.ed-sheet-limbs .ed-fx-item').length`);
  var apSw = String(await ev(`getComputedStyle(document.querySelector('.ed-sheet-sw')).backgroundColor`));
  var AP_PALETTE = ["rgb(255, 96, 96)", "rgb(96, 220, 96)", "rgb(96, 160, 255)", "rgb(255, 208, 64)", "rgb(224, 96, 255)", "rgb(64, 232, 224)", "rgb(255, 152, 48)", "rgb(160, 160, 160)"];
  var AP_RGB = [[255, 96, 96], [96, 220, 96], [96, 160, 255], [255, 208, 64], [224, 96, 255], [64, 232, 224], [255, 152, 48], [160, 160, 160]];
  /** 叠加层是 globalAlpha 0.85 画的 ⇒ 期望像素 = 0.85×调色板色 + 0.15×底图色 */
  var apTint = (base) => AP_RGB.map((c) => c.map((v, i) => 0.85 * v + 0.15 * base[i]));
  var apNear = (px, list) => list.some((c) => c.every((v, i) => Math.abs(px[i] - v) <= 14));
  check(apNLimb >= 1 && AP_PALETTE.includes(apSw), `自动抠图：${apNLimb} 块 limb，色块取调色板色（${apSw}）`);
  check((await ev(`!!document.querySelector('.ed-sheet .ed-sheet-apply')`)) === true, "抠图后「应用部件」「上移 / 下移」都出现");

  // ── View：前景视图把 limb 涂成调色板色（红 / 蓝两半至少一半变色；取样点避开中间的分界线） ──
  var apRed = worldToPage(apCr, [940, 590]);
  var apBlue = worldToPage(apCr, [980, 490]);
  // 载入原图成功后编辑器自己就进了角色表视图（`.ed-sheet-load` 里 `geomMode = "sheet"`）⇒ 先关掉取「覆盖前」像素，再开回来
  var apViewEt = await ev(`document.querySelector('#ed-inspector .ed-sheet-view').dataset.et`);
  check(apViewEt === "sheet.viewOn", `载入原图后自动进入角色表视图（按钮态 ${apViewEt}）`);
  await clickSel(".ed-sheet-view");
  await waitFor(`document.querySelector('#ed-inspector .ed-sheet-view').dataset.et === 'sheet.viewBtn'`, 20000);
  var vR0 = await pixelAt(apRed);
  var vB0 = await pixelAt(apBlue);
  await clickSel(".ed-sheet-view");
  await waitFor(`document.querySelector('#ed-inspector .ed-sheet-view').dataset.et === 'sheet.viewOn'`, 20000);
  var vR1 = await pixelAt(apRed);
  var vB1 = await pixelAt(apBlue);
  var apRedOn = apDiff(vR0, vR1) > 30;
  var apBlueOn = apDiff(vB0, vB1) > 30;
  // 这张 fixture 上「红」是边框主色 ⇒ 被当成背景，「蓝」那半才是 limb ⇒ 恰好一半（前景那半）叠上调色板色。
  // 判据按「哪半盖住了」而不是写死蓝半：哪一半被当背景由 dominantBorderColor 的量化桶决定
  var apTintHit = (a, b) => apDiff(a, b) > 30 && apNear(b, apTint(a));
  check(apTintHit(vR0, vR1) !== apTintHit(vB0, vB1),
    `开角色表视图：恰好前景那半叠上调色板色（红半 ${vR0}→${vR1} / 蓝半 ${vB0}→${vB1}）`);

  // ── 画笔涂 limb（Mask 开）：新加一块空 limb（`.ed-sheet-add` 自动选中它）⇒ 涂哪里都会让它像素数变多 ──
  var apPaint = [940, 590];
  await clickSel(".ed-sheet-add");
  await apToggle(".ed-sheet-mask", true);
  var apPx0 = await apActivePx();
  await drag(worldToPage(apCr, [apPaint[0] - 30, apPaint[1]]), worldToPage(apCr, [apPaint[0] + 30, apPaint[1]]));
  var apPx1 = await apActivePx();
  check(apPx0 === 0 && apPx1 > 100, `画笔涂 limb（Mask 开）：新空 limb 的掩码像素 ${apPx0} → ${apPx1}`);

  // ── 画笔标背景（Mask 关）+ 背景视图：那一块被涂成白色（Mark Background；叠加层是 85% 不透明度） ──
  await apToggle(".ed-sheet-mask", false);
  await apPick(".ed-sheet-viewsel", "background");
  await drag(worldToPage(apCr, [apPaint[0] - 30, apPaint[1]]), worldToPage(apCr, [apPaint[0] + 30, apPaint[1]]));
  var apBg = await pixelAt(worldToPage(apCr, apPaint));
  check(apBg[0] > 200 && apBg[1] > 150 && apBg[2] > 180, `Mask 关 + 背景视图：涂过的那块是背景白（像素 ${apBg}）`);

  // ── 应用部件：三角形按 limb 重排进 .mdl，画面不变 ──
  await apPick(".ed-sheet-viewsel", "foreground");
  await clickSel(".ed-sheet-view"); // 关掉角色表叠加层，之后按真实渲染比像素
  var apRealR = await pixelAt(apRed);
  var apRealB = await pixelAt(apBlue);
  // 应用前的那份盘上索引（不能用更早读到的 mC：中途还翻过格子，翻转会改变每个顶点出现的次数）
  var mPre = apMdl(apDisk(await saveLoose()));
  var apIdxBefore = Array.from(mPre.indices);
  var apRcApply = await h.readyCount();
  await clickSel(".ed-sheet-apply");
  await h.waitRemount(apRcApply);
  await apPins();
  apCr = await h.canvasRect();
  check(apDiff(await pixelAt(apRed), apRealR) <= 8 && apDiff(await pixelAt(apBlue), apRealB) <= 8, "应用部件后画面逐像素不变（只重排三角形）");
  var dF = apDisk(await saveLoose());
  var mF = apMdl(dF);
  check(mF.indexCount === mPre.indexCount, `应用部件不增删索引（${mPre.indexCount} → ${mF.indexCount}）`);
  /** 三角形集合（每个三角形的三个下标排序后归一，再整体排序）——重排不该改变它 */
  var apTris = (idx) => {
    const t = [];
    for (let i = 0; i + 2 < idx.length; i += 3) t.push([idx[i], idx[i + 1], idx[i + 2]].sort((a, b) => a - b).join("_"));
    return t.sort().join("|");
  };
  check(apTris(Array.from(mF.indices)) === apTris(apIdxBefore), "应用部件只重排三角形（三角形集合逐项相同）");
  var apParts = mF.parts ?? [];
  var apCovered = apParts.reduce((s, p) => s + p.size, 0);
  check(
    apParts.length >= 1 && apCovered === mF.indexCount && apParts[0].start === 0 && apParts.every((p, i) => i === 0 || p.start === apParts[i - 1].start + apParts[i - 1].size),
    `盘上部件表首尾相接且恰好铺满索引表（${apParts.length} 块：${apParts.map((p) => `${p.id}@${p.start}+${p.size}`).join(" ")}）`,
  );
  check(dF.json?.puppetWarp?.limbs?.count >= 1, `盘上模型 json 记着角色表分割（limbs.count = ${dF.json?.puppetWarp?.limbs?.count}）`);
  check(Buffer.compare(fs.readFileSync(path.join(dF.dir, "materials/editor/stripe.png")), fs.readFileSync(stripePath)) === 0, "源图仍是逐字节原图（几何与部件都没动贴图）");

  // ── 存库重开：几何创作态（Padding / 细分 / 切片 / 拓扑 / 锁）全读回来 ──
  await reopen(apIdA);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length >= 1`, 90000);
  await waitFor(`/首帧就绪|First frame ready/.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await click(await h.rowCenter("stripe"));
  var apOpen = await waitFor(`!!document.querySelector('.ed-warp .ed-warp-open')`, 40000).then(() => true, () => false);
  if (!apOpen) {
    var apTree = await h.treeNames();
    var apGroups = await ev(`[...document.querySelectorAll('#ed-inspector .ed-insp-group .ed-insp-title')].map((d) => d.textContent).join(' | ')`);
    var apSelName = await h.selectedName();
    var apImg = apDisk(apIdA);
    const keys = apImg.json ? Object.keys(apImg.json).join(",") : "(没有模型 json)";
    check(false, `重开后找不到「进入操控变形」：树 [${apTree}] 选中「${apSelName}」/ 分组 [${apGroups}] / obj.image ${apImg.obj?.image} / json 键 [${keys}] / 页面错误 [${(await h.errorLines()).join(" ; ")}]`);
  }
  await clickSel(".ed-warp-open");
  await apPins();
  apCr = await h.canvasRect();
  check((await apVal(".ed-geom-pad")) === "40" && (await apVal(".ed-geom-sub")) === "2" && (await apVal(".ed-geom-cols")) === "32",
    `重开：Padding ${await apVal(".ed-geom-pad")} / 细分 ${await apVal(".ed-geom-sub")} / 基础格数 ${await apVal(".ed-geom-cols")} 读回来`);
  check((await ev(`document.querySelector('#ed-inspector .ed-geom-lock').checked`)) === true, "重开：Lock geometry 读回来");
  var apDiskR = apDisk(apIdA);
  check(
    (apDiskR.json?.puppetWarp?.geometry?.sliceX ?? []).length === 1 && (apDiskR.json?.puppetWarp?.geometry?.topology?.flips ?? []).length === 1,
    "重开：切片线与翻转格子都还在盘上（geometry.sliceX / topology.flips 非空）",
  );

  var apErrs = await h.errorLines();
  check(apErrs.length === 0, `几何与角色表全程控制台无错误${apErrs.length ? `：${apErrs.slice(0, 2).join(" / ")}` : ""}`);
  } catch (err) { await hlAbort("AP", apName, err); }
}

await geomE2E();

/**
 * AQ. 骨架与权重（P2）：新建骨架 → 打点建骨 / 命名 / 父子 → 应用（MDLS + 每顶点 4 槽权重）→
 * 涂抹 / 平滑 / 孤岛混合 → 转动预览 → 绘制序 → 存库重开。
 * 判据 = 盘上 .mdl（引擎自己的 mdl-parse 读回骨名 / meta / 蒙皮槽）+ CDP 截图的真实像素。
 */
async function skelE2E() {
  var aqName = "AQ. 骨架与权重（P2：骨架 → 打点建骨 → 应用 → 涂抹 → 平滑 / 孤岛 → 绘制序 → 重开）";
  section(aqName);
  if (hlState.dead) hlSkip("AQ", aqName); else try {
  var parseMDL = (await imp("renderer/vendor/we-scene/render/mdl-parse.js")).parseMDL;
  /** 盘上「stripe」层的模型 json（+ 目录 / 场景对象），与 AO / AP 段同法 */
  var aqDisk = (id) => {
    const dir = path.join(lib, id);
    const sc = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
    const obj = (sc.objects ?? []).find((o) => o.name === "stripe") ?? (sc.objects ?? [])[0];
    return { dir, sc, obj, json: obj ? JSON.parse(fs.readFileSync(path.join(dir, String(obj.image)), "utf8")) : null };
  };
  var aqMdl = (d) => parseMDL(new Uint8Array(fs.readFileSync(path.join(d.dir, d.json.puppet))));
  var aqEl = (sel) => `document.querySelector('#ed-inspector ${sel}')`;
  var aqHas = async (sel) => (await ev(`!!document.querySelector('${sel}')`)) === true;
  var aqVal = (sel) => ev(`(() => { const el = ${aqEl(sel)}; return el ? String(el.value) : null; })()`);
  var aqSet = (sel, v) => ev(`(() => { const el = ${aqEl(sel)}; if (!el) return false; el.value = '${v}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var aqToggle = (sel, on) => ev(`(() => { const el = ${aqEl(sel)}; if (!el) return false; el.checked = ${on ? "true" : "false"}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var aqPick = (sel, v) => ev(`(() => { const el = ${aqEl(sel)}; if (!el) return false; el.value = '${v}'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  var aqDiff = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
  var aqNth = (sel, i, evt = "click") => ev(`(() => { const el = document.querySelectorAll('${sel}')[${i}]; if (!el) return false; el.${evt}(); return true; })()`);
  /** 某个分组里的 note 文本数组（骨架 / 权重面板用 note 报数） */
  var aqNotes = (cls) => ev(`[...document.querySelectorAll('#ed-inspector .${cls} .ed-note')].map((d) => d.textContent)`);
  var aqLogTail = (n = 4) => ev(`[...document.querySelectorAll('#ed-con-body > div')].slice(-${n}).map((d) => d.textContent).join(' ⏎ ')`);
  /** #ed-overlay 叠加层上该页面坐标附近 n×n 里 alpha 最大的像素（与 AP 段同一套判法） */
  var aqOverlay = (pt, n = 5) => ev(`(() => {
    const cv = document.querySelector('#ed-overlay');
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const x = Math.round((${pt[0]} - r.left) * k);
    const y = Math.round((${pt[1]} - r.top) * k);
    const h = ${n} >> 1;
    const d = cv.getContext('2d').getImageData(x - h, y - h, ${n}, ${n}).data;
    let best = [0, 0, 0, 0];
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > best[3]) best = [d[i], d[i + 1], d[i + 2], d[i + 3]];
    return best;
  })()`);
  /** 叠加层上按颜色找骨点（蓝 = 未选中骨；黄 = 选中骨 / 钉子，都是同一块画布上的页坐标范围） */
  var aqScanBones = () => ev(`(() => {
    const cv = document.querySelector('#ed-overlay');
    const r = cv.getBoundingClientRect();
    const k = cv.width / r.width;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    const acc = { blue: 0, yellow: 0, bx0: 1e9, by0: 1e9, bx1: -1e9, by1: -1e9, yx0: 1e9, yy0: 1e9, yx1: -1e9, yy1: -1e9 };
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      const i = (y * cv.width + x) * 4;
      if (d[i + 3] < 120) continue;
      const R = d[i], G = d[i + 1], B = d[i + 2];
      const px = x / k + r.left, py = y / k + r.top;
      if (B > 150 && B > R + 40 && G > 120) {
        acc.blue++;
        if (px < acc.bx0) acc.bx0 = px; if (px > acc.bx1) acc.bx1 = px;
        if (py < acc.by0) acc.by0 = py; if (py > acc.by1) acc.by1 = py;
      } else if (R > 180 && G > 150 && B < 150 && R > B + 60) {
        acc.yellow++;
        if (px < acc.yx0) acc.yx0 = px; if (px > acc.yx1) acc.yx1 = px;
        if (py < acc.yy0) acc.yy0 = py; if (py > acc.yy1) acc.yy1 = py;
      }
    }
    return acc;
  })()`);
  var aqPins = () => waitFor(`document.querySelectorAll('.ed-warp-pins .ed-fx-item').length === 9`, 60000);
  /** 面板按钮点了才算数：元素不在就记一条 ✗，别让 clickSel 抛异常把整段判据打断 */
  var aqClick = async (sel, what) => {
    if (!(await aqHas(sel))) {
      check(false, `${what}：面板里没有 ${sel}`);
      return false;
    }
    await clickSel(sel);
    return true;
  };

  /** 写盘 → 等重挂 → 钉子回来（P2 的每一次写都换一份新 slug 的 .mdl） */
  var aqApply = async (sel) => {
    const rc = await h.readyCount();
    if (!(await aqHas(sel))) {
      check(false, `写回按钮不存在：${sel}`);
      return h.canvasRect();
    }
    await clickSel(sel);
    await h.waitRemount(rc);
    await aqPins();
    return h.canvasRect();
  };
  /** 三角形成员集合（每三个下标排序后归一，再整体排序）——重排绘制序不该改变它 */
  var aqTris = (idx) => {
    const t = [];
    for (let i = 0; i + 2 < idx.length; i += 3) t.push([idx[i], idx[i + 1], idx[i + 2]].sort((a, b) => a - b).join("_"));
    return t.sort().join("|");
  };
  /** 权重不变量：4 槽、每顶点 Σ>0、骨号都落在 [0, bones) */
  var aqSkinOk = (m) => {
    const vc = m.vertexCount;
    let zero = 0;
    let bad = 0;
    for (let v = 0; v < vc; v++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const w = m.weights[v * 4 + k];
        if (!Number.isFinite(w) || w < 0) bad++;
        sum += w;
        if (m.boneIdx[v * 4 + k] >= m.bones.length) bad++;
      }
      if (sum <= 1e-4) zero++;
    }
    return { zero, bad };
  };

  await gotoEditor();
  await clearLocalStore();
  await gotoEditor();
  await newBlank(BG);
  // 夹具：外圈 16px 实心蓝边（自动抠图需要一块与边框相连的纯色背景）+ 内部**大块非周期**图案
  //（骨架 / 权重的像素判据要看「网格动没动」：纯色图内部形变在像素上不可见，AQ 初版「转动预览 0px」
  // 就是被纯色图骗的；细棋盘格也不可靠 —— 周期 4px 的格子对几十像素的旋转会「同色对上」，又把真形变量成 0；
  // 整张纯棋盘格还会让 autoLimbs 找不到背景 ⇒ 一条 limb 都出不来、整段超时。故用「纯色边框 + 大块十字带 + 圆盘」）。
  // 文件名仍叫 stripe.png ⇒ 层名与 aqDisk 不用改。
  var aqPatternDir = path.join(tmpRoot, "aq-pattern");
  fs.mkdirSync(aqPatternDir, { recursive: true });
  var aqPatternPath = path.join(aqPatternDir, "stripe.png");
  var aqPW = 400;
  var aqPH = 200;
  var aqPM = 16;
  var aqPStride = aqPW * 3 + 1;
  var aqPRaw = Buffer.alloc(aqPStride * aqPH);
  for (let y = 0; y < aqPH; y++) {
    for (let x = 0; x < aqPW; x++) {
      const inside = x >= aqPM && x < aqPW - aqPM && y >= aqPM && y < aqPH - aqPM;
      const bandV = x >= 150 && x < 190;
      const bandH = y >= 78 && y < 112;
      const disc = (x - 318) * (x - 318) + (y - 62) * (y - 62) < 1156; // r = 34
      const c = !inside
        ? [40, 60, 220]
        : bandV || bandH
          ? [220, 40, 40]
          : disc
            ? [30, 30, 30]
            : [235, 235, 235];
      aqPRaw.set(c, y * aqPStride + 1 + x * 3);
    }
  }
  fs.writeFileSync(aqPatternPath, rgbPng(aqPW, aqPH, aqPRaw));
  await addImage(aqPatternPath);
  var aqRc = await h.readyCount();
  await clickSel(".ed-warp-make");
  await h.waitRemount(aqRc);
  await aqPins();
  var aqCr = await h.canvasRect();

  // ── 先跑一遍角色表：部件表只有它（或带 partOrder 的几何重建）能产出，绘制序要用 ──
  await clickSel(".ed-sheet-load");
  await waitFor(`!!document.querySelector('.ed-sheet .ed-sheet-auto')`, 30000);
  await clickSel(".ed-sheet-auto");
  await waitFor(`document.querySelectorAll('.ed-sheet-limbs .ed-fx-item').length >= 1`, 30000);
  await clickSel(".ed-sheet-add");
  await aqToggle(".ed-sheet-mask", true);
  await drag(worldToPage(aqCr, [910, 590]), worldToPage(aqCr, [970, 590]));
  await aqToggle(".ed-sheet-mask", false);
  var aqRcSheet = await h.readyCount();
  await clickSel(".ed-sheet-apply");
  await h.waitRemount(aqRcSheet);
  await aqPins();
  aqCr = await h.canvasRect();
  // 应用部件后 P1 会回到「几何」视图（写盘后 geomWriteSession 恢复 geomMode）⇒ 关掉它，让 P2 独占指针
  var aqGeomEt = await ev(`(() => { const el = document.querySelector('#ed-inspector .ed-geom-view'); return el ? el.dataset.et : null; })()`);
  if (aqGeomEt === "geo.viewOn") {
    await clickSel(".ed-geom-view");
    await waitFor(`document.querySelector('#ed-inspector .ed-geom-view').dataset.et === 'geo.view'`, 20000);
  }
  var aqBase = aqDisk(await saveLoose());
  var aqM0 = aqMdl(aqBase);
  check((aqM0.parts ?? []).length >= 2, `角色表已给出部件表（${(aqM0.parts ?? []).length} 块），绘制序才有东西可排`);

  // ── 两个分组：骨架 / 权重 ──
  check((await aqHas(".ed-skel .ed-skel-new")) && (await aqHas(".ed-wt .ed-wt-newskel")), "转木偶后骨架 / 权重两个分组都出现（P2）");
  check(/骨架|Skeleton/.test(await ev(`document.querySelector('.ed-skel .ed-insp-title').textContent`)), "骨架分组标题本地化");
  check(/权重|Weights/.test(await ev(`document.querySelector('.ed-wt .ed-insp-title').textContent`)), "权重分组标题本地化");
  var aqNotes0 = await aqNotes("ed-skel");
  check(/还没有骨|No bones yet/.test(aqNotes0[1] ?? ""), `还没有骨架时如实提示（${aqNotes0[1]}）`);
  var aqVerts = Number(((aqNotes0[0] ?? "").match(/\d+/g) ?? [])[1] ?? NaN);
  check(aqVerts === aqM0.vertexCount, `骨架摘要里的顶点数与盘上一致（面板 ${aqVerts} / .mdl ${aqM0.vertexCount}）`);
  check(/先建骨架再涂权重|Create a skeleton before painting/i.test((await aqNotes("ed-wt"))[0] ?? ""), "权重分组在没骨架时给出去处提示");

  // ── 新建骨架：默认 6 根（root / spine / 双臂 / 双腿），自动进骨架模式 ──
  if (await aqClick(".ed-skel-new", "新建骨架")) {
    await waitFor(`document.querySelectorAll('#ed-inspector .ed-skel-list .ed-skel-bone').length === 6`, 20000);
  }
  check((await ev(`document.querySelector('#ed-inspector .ed-skel-view').dataset.et`)) === "skel.viewOn", "「新建骨架」顺手进入骨架模式");
  var aqN1 = await aqNotes("ed-skel");
  check(/6 根|6 bones/.test(aqN1[0] ?? ""), `默认骨架 6 根（${aqN1[0]}）`);
  check(/根骨|root/i.test(aqN1[1] ?? ""), "有骨架后提示第 1 根是根骨 / 怎么改父级");
  check(/骨骼列表|Bones/i.test(aqN1[2] ?? "") && (await ev(`document.querySelectorAll('#ed-inspector .ed-skel-bone')[0].textContent`)) === "1. root", `骨列表按序号列出（第 1 根是 root；注记「${aqN1[2]}」）`);
  // 骨点画在默认骨架的位置上（模型 → 图像：图像中心 = 世界 960,590；root (0,-50) / arm L (-80,60)）
  var aqArmPt = worldToPage(aqCr, [880, 530]);
  var aqORoot = await aqOverlay(worldToPage(aqCr, [960, 640]));
  var aqBones = await aqScanBones();
  check(aqORoot[3] > 120 && aqORoot[0] > 150 && aqORoot[0] > aqORoot[2], `骨架叠加层在根骨位置画出选中骨（黄的，像素 ${aqORoot}）`);
  check(aqBones.blue >= 20 && aqBones.bx1 - aqBones.bx0 > 20 && aqBones.by1 - aqBones.by0 > 15, `骨架叠加层画出多根未选中骨点（蓝像素 ${aqBones.blue}，页范围 ${Math.round(aqBones.bx0)},${Math.round(aqBones.by0)}–${Math.round(aqBones.bx1)},${Math.round(aqBones.by1)}；arm L 预测 ${aqArmPt.map((v) => Math.round(v))}）`);

  // ── 选中 + 改名 ──
  await aqNth("#ed-inspector .ed-skel-bone", 1);
  await waitFor(`(document.querySelector('#ed-inspector .ed-skel-name') || {}).value === 'spine'`, 20000);
  await aqSet(".ed-skel-name", "spine");
  check((await aqVal(".ed-skel-name")) === "spine" && /^2\. spine$/.test(await ev(`document.querySelectorAll('#ed-inspector .ed-skel-bone')[1].textContent`)), "改名写回骨列表（第 2 根 → spine）");
  check(/改名|renamed/i.test(await aqLogTail(2)), "改名写日志");

  // ── 打点建骨：待命后点画布两次（先选中 spine ⇒ 新骨挂到 spine 下），画面与层选择都不许被动 ──
  var aqRcBones = await h.readyCount();
  if (await aqClick(".ed-skel-arm", "打点建骨")) {
    check((await ev(`document.querySelector('#ed-inspector .ed-skel-arm').classList.contains('is-arm')`)) === true, "「打点建骨」进入待命态（按钮高亮）");
    await click(worldToPage(aqCr, [900, 620])); // 模型 (-60,-30)
    await click(worldToPage(aqCr, [860, 590])); // 模型 (-100,0)
    await waitFor(`document.querySelectorAll('#ed-inspector .ed-skel-list .ed-skel-bone').length === 8`, 20000);
  }
  var aqNewTitle = await ev(`document.querySelectorAll('#ed-inspector .ed-skel-bone')[6].title`);
  check(/spine/.test(aqNewTitle ?? ""), `打点建骨连到选中骨下（第 7 根的父级：${aqNewTitle}）`);
  check((await h.selectedName()) === "stripe", "画布上打点建骨不改层选择（骨架模式吞掉了这一次 click）");
  check((await h.readyCount()) === aqRcBones, "打点建骨不重挂场景（点击没被手柄 / 钉子抢走）");

  // ── 应用骨架：写 MDLS（骨名 + 父子 + pw 参数）并顺手重算 4 槽权重 ──
  // 采样点铺在模型四角与上下边（远离骨点 / 钉子 / 父子连线），并且**隐藏 #ed-overlay 再截图**：
  // 这条判的是「网格本身有没有动」。写盘后钉子手柄会从 3×3 网格跳到骨位置，叠加层混进来量不准
  //（初版就是这么量出 128px 的假差）。
  var aqSkinPix = [[800, 515], [1120, 515], [800, 665], [1120, 665], [960, 520], [960, 660]];
  /** 藏 / 显叠加层：inline 之外再挂一张 `!important` 样式表（只藏 inline 时实测仍有假差，见 AQ 正对照） */
  var aqHideOverlay = (hide) => ev(`(() => {
    let st = document.getElementById('aq-hide-overlay');
    if (${hide} && !st) {
      st = document.createElement('style');
      st.id = 'aq-hide-overlay';
      st.textContent = '#ed-overlay{visibility:hidden !important}';
      document.head.appendChild(st);
    }
    if (!${hide} && st) st.remove();
    const el = document.querySelector('#ed-overlay');
    if (el) el.style.visibility = ${hide} ? 'hidden' : '';
    return true;
  })()`);
  var aqMeshPix = async (pts) => {
    await aqHideOverlay(true);
    const out = [];
    for (const p of pts) out.push(await pixelAt(worldToPage(aqCr, p)));
    await aqHideOverlay(false);
    return out;
  };
  // 正对照：根骨那里本来画着骨点（选中黄 / 未选蓝），藏起来后像素必须变 —— 否则量的是叠加层不是网格。
  var aqRootPt = worldToPage(aqCr, [960, 640]);
  var aqRootShow = await pixelAt(aqRootPt);
  var aqRootHide = (await aqMeshPix([[960, 640]]))[0];
  check(aqDiff(aqRootShow, aqRootHide) >= 20, `量网格前把叠加层藏起来（根骨 ${aqRootShow.join("/")} → ${aqRootHide.join("/")}）`);
  // ── 临时诊断（定位「应用骨架动了画面」）：盘上模型前后对比 + 沿横线扫色 ──
  var aqAabbOf = (m) => {
    const p = m.positions;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 2 < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i];
      if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1];
      if (p[i + 1] > y1) y1 = p[i + 1];
    }
    return `${Math.round(x0)},${Math.round(y0)}..${Math.round(x1)},${Math.round(y1)}`;
  };
  var aqMdlNote = (m, d) =>
    `${m.bones.length} 骨[${m.bones.map((b) => b.name).join(",")}] / ${m.vertexCount} 顶点 / AABB ${aqAabbOf(m)} / ` +
    `obj ${d.obj?.width ?? "?"}×${d.obj?.height ?? "?"} ${d.obj?.origin ?? "?"} scale ${d.obj?.scale ?? "?"} / ` +
    `静态姿势 ${m.staticPoseAt ?? "?"} / 片段 ${(m.animations ?? []).length}`;
  var aqLinePts = [];
  for (let x = 720; x <= 1200; x += 20) aqLinePts.push([x, 560]);
  for (let x = 720; x <= 1200; x += 20) aqLinePts.push([x, 660]);
  var aqLine = async (pts) => {
    const cs = await aqMeshPix(pts);
    return cs.map((c) => (c[0] > 200 && c[1] > 200 ? "W" : c[0] > 150 && c[1] < 120 ? "R" : c[2] > 150 && c[0] < 120 ? "B" : c[0] < 90 && c[2] > 90 && c[2] < 210 ? "g" : ".")).join("");
  };
  var aqDPre = aqDisk(await saveLoose());
  var aqMPre = aqMdl(aqDPre);
  var aqPreLine = await aqLine(aqLinePts);
  console.log(`  · 应用前：${aqMdlNote(aqMPre, aqDPre)}；画面 ${aqPreLine}`);
  var aqCrBefore = aqCr;
  var aqPixBefore = await aqMeshPix(aqSkinPix);
  aqCr = await aqApply(".ed-skel-apply");
  var aqId = await saveLoose();
  var aqD1 = aqDisk(aqId);
  var aqM1 = aqMdl(aqD1);
  check(aqM1.bones.length === 8, `8 根骨写进 MDLS（${aqM1.bones.map((b) => b.name).join(" ")}）`);
  check(/spine/.test(aqM1.bones.map((b) => b.name).join(",")) && aqM1.bones[1].parent === 0, `骨名与父子关系都落了盘（spine 的父级 = ${aqM1.bones[1].parent}）`);
  var aqMetaOk = 0;
  for (const bm of aqM1.boneMeta) {
    const meta = JSON.parse(bm.meta || "{}");
    if (meta.pw && meta.pw.stiffness === 0.5 && meta.pw.damping === 0.2) aqMetaOk++;
  }
  check(aqMetaOk === 8, `物理参数写进每根骨 meta 的 pw 键（${aqMetaOk}/8：stiffness 0.5 / damping 0.2）`);
  var aqInv1 = aqSkinOk(aqM1);
  check(aqInv1.bad === 0 && aqInv1.zero === 0, `应用骨架顺手给出每顶点 4 槽权重（异常 ${aqInv1.bad} / 全零 ${aqInv1.zero}）`);
  check(aqD1.json?.puppetWarp?.skeleton?.bones?.length === 8 && aqD1.json.puppetWarp.skeleton.bones.some((b) => b.name === "spine"), "模型 json 记着骨架（puppetWarp.skeleton.bones）");
  // 骨表 10 → 8：旧 MDLA 轨道的骨号整批失效（removeMdlClip 有「首个不许删」的保护，杀不掉单片段木偶的片段）
  check((aqM1.animations ?? []).length === 0, `骨表换了就把盘上片段整批作废（片段 ${(aqM1.animations ?? []).length}）`);
  var aqPixAfter = await aqMeshPix(aqSkinPix);
  var aqMaxSkin = Math.max(...aqSkinPix.map((_, i) => aqDiff(aqPixBefore[i], aqPixAfter[i])));
  var aqCrMoved = Math.abs(aqCrBefore.left - aqCr.left) > 0.5 || Math.abs(aqCrBefore.top - aqCr.top) > 0.5 ||
    Math.abs(aqCrBefore.width - aqCr.width) > 0.5 || Math.abs(aqCrBefore.height - aqCr.height) > 0.5;
  var aqPostLine = await aqLine(aqLinePts);
  console.log(`  · 应用后：${aqMdlNote(aqM1, aqD1)}；画面 ${aqPostLine}`);
  // 再应用一次（幂等）：写盘 → 重挂的噪声地板；顺带确认「骨表没变就不动盘上片段」这条分支不误伤画面
  aqCr = await aqApply(".ed-skel-apply");
  var aqPixAgain = await aqMeshPix(aqSkinPix);
  var aqMaxAgain = Math.max(...aqSkinPix.map((_, i) => aqDiff(aqPixAfter[i], aqPixAgain[i])));
  check(aqMaxAgain <= 8, `再应用一次骨架画面也不动（重挂→重挂 最大像素差 ${aqMaxAgain}）`);
  aqD1 = aqDisk(await saveLoose());
  aqM1 = aqMdl(aqD1);
  check(aqMaxSkin <= 8, `应用骨架不动画面（隐藏叠加层后最大像素差 ${aqMaxSkin}；画布矩形${aqCrMoved ? `变了 ${Math.round(aqCrBefore.left)},${Math.round(aqCrBefore.top)} ${Math.round(aqCrBefore.width)}×${Math.round(aqCrBefore.height)} → ${Math.round(aqCr.left)},${Math.round(aqCr.top)} ${Math.round(aqCr.width)}×${Math.round(aqCr.height)}` : "没变"}；采样 ${aqPixBefore.map((c, i) => `${c.join("/")}→${aqPixAfter[i].join("/")}`).join(" ")}）`);


  // ── 权重面板：8 根目标骨 / 全部有 4 槽权重 / 孤岛数 ──
  var aqTargets = await ev(`document.querySelectorAll('#ed-inspector .ed-wt-target option').length`);
  check(aqTargets === 8, `权重面板按盘上骨架列出目标骨（${aqTargets} 项）`);
  var aqNote1 = (await aqNotes("ed-wt"))[0] ?? "";
  check(/未涂 0|0 unweighted/.test(aqNote1), `应用骨架后每个顶点都有权重（${aqNote1}）`);
  check((await aqHas(".ed-wt .ed-wt-part")) && (await aqHas(".ed-wt .ed-wt-front")), "权重面板列出部件表与「移到最前」（部件表已落盘）");

  // ── 涂抹权重：目标骨 2 + 沿一条线拖笔 → 日志 + 落盘后骨号真的多出来 ──
  if (await aqClick(".ed-wt-paint", "开始涂权重")) {
    await waitFor(`document.querySelector('#ed-inspector .ed-wt-paint').dataset.et === 'wt.paintOn'`, 20000);
  }
  await aqPick(".ed-wt-target", "2");
  var aqSlots2Before = Array.from(aqM1.boneIdx).filter((v) => v === 2).length;
  await drag(worldToPage(aqCr, [900, 590]), worldToPage(aqCr, [1030, 590]));
  var aqPaintLog = await aqLogTail(2);
  check(/涂抹骨|Painted bone/i.test(aqPaintLog), `涂抹写出日志（${aqPaintLog.slice(0, 90)}）`);
  await aqClick(".ed-wt-smooth", "平滑全部权重");
  check(/平滑|Smoothed/i.test(await aqLogTail(2)), "「平滑全部权重」写出日志");
  await aqClick(".ed-wt-blend", "孤岛混合");
  check(/孤岛|island/i.test(await aqLogTail(2)), "「孤岛混合」写出日志");
  aqCr = await aqApply(".ed-wt-apply");
  var aqD2 = aqDisk(await saveLoose());
  var aqM2 = aqMdl(aqD2);
  var aqSlots2After = Array.from(aqM2.boneIdx).filter((v) => v === 2).length;
  check(aqSlots2After > aqSlots2Before, `涂抹进了 .mdl：骨号 2 的蒙皮槽 ${aqSlots2Before} → ${aqSlots2After}（笔刷把目标骨挤进 4 槽）`);
  var aqInv2 = aqSkinOk(aqM2);
  check(aqInv2.bad === 0 && aqInv2.zero === 0, `涂抹 + 平滑 + 孤岛混合后权重仍合法（异常 ${aqInv2.bad} / 全零 ${aqInv2.zero}）`);
  check(aqD2.json?.puppetWarp?.weights !== undefined, "模型 json 记着权重状态（puppetWarp.weights）");

  // ── 转动预览：只动引擎姿势不写盘；重置姿势回到绑定姿势 ──
  // 同样隐藏叠加层量网格（夹具内部是大块非周期图案 ⇒ 形变一定改像素）。
  // 目标骨选**根骨**：转根骨会带动整条父链（每个顶点的骨都挂在它下面），采样点不必正好落在某个 island 里。
  await aqPick(".ed-wt-target", "0");
  var aqPose = [];
  for (let px = 800; px <= 1120; px += 80) for (let py = 520; py <= 660; py += 70) aqPose.push([px, py]);
  var aqPose0 = await aqMeshPix(aqPose);
  var aqPoseSet = await aqSet(".ed-wt-pose", 120);
  check(aqPoseSet === true, "权重面板有「转动预览」滑杆（.ed-wt-pose）");
  var aqPose1 = await aqMeshPix(aqPose);
  var aqPoseMax = Math.max(...aqPose.map((_, i) => aqDiff(aqPose0[i], aqPose1[i])));
  check(aqPoseMax > 25, `转动预览当场把画面转起来（最大像素差 ${aqPoseMax}，不写盘；${aqPose.map((p, i) => `${p.join(",")} ${aqPose0[i].join("/")}→${aqPose1[i].join("/")}`).join(" ")}）`);
  await aqClick(".ed-wt-poserest", "重置姿势");
  var aqPose2 = await aqMeshPix(aqPose);
  var aqPoseBack = Math.max(...aqPose.map((_, i) => aqDiff(aqPose0[i], aqPose2[i])));
  check(aqPoseBack <= 8, `重置姿势回到绑定姿势（最大像素差 ${aqPoseBack}）`);

  // ── 显示深度序：叠加层按部件绘制序着色（面板同时如实说明本机看不出前后） ──
  await aqClick(".ed-wt-depth", "显示深度序");
  check((await ev(`document.querySelector('#ed-inspector .ed-wt-depth').classList.contains('is-arm')`)) === true, "「显示深度序」进入待命态");
  check(/WE 侧生效|effective on the WE side/i.test((await aqNotes("ed-wt")).join(" ")), "面板如实标注深度序只在 WE 侧生效");
  await aqClick(".ed-wt-depth", "关掉显示深度序");

  // ── 移到最前：索引表按新绘制序重排（索引顺序变、三角形集合与部件表不变） ──
  var aqPartsN = await ev(`document.querySelectorAll('#ed-inspector .ed-wt-part option').length`);
  check(aqPartsN >= 2, `部件选择列出全部部件（${aqPartsN} 块）`);
  var aqIdxBefore2 = Array.from(aqM2.indices);
  var aqFrontId = aqM2.parts[0].id;
  await aqPick(".ed-wt-part", "0"); // 第 0 块 => 整段搬到索引表末尾（已经在最后的部件搬了 = 无操作）
  aqCr = await aqApply(".ed-wt-front");
  var aqD3 = aqDisk(await saveLoose());
  var aqM3 = aqMdl(aqD3);
  var aqIdxAfter2 = Array.from(aqM3.indices);
  var aqMoved = aqIdxBefore2.some((v, i) => v !== aqIdxAfter2[i]);
  var aqPartsAfter2 = aqM3.parts ?? [];
  var aqTail = aqPartsAfter2[aqPartsAfter2.length - 1];
  // 引擎解析器给的部件只有 id / start / size，**没有 offset**（draw_order_offset 只有写侧知道），
  // 所以这里只判「末块就是被点那块」；offset 抬高由离线 SKEL 段用 MdlPart 本体单测。
  check(
    aqMoved && aqM3.indexCount === aqM2.indexCount && aqTris(aqIdxAfter2) === aqTris(aqIdxBefore2) &&
      aqTail && aqTail.id === aqFrontId,
    `「移到最前」把该部件的索引区间整段搬到表尾（索引顺序变了=${aqMoved} / 索引数 ${aqM2.indexCount}→${aqM3.indexCount} / 三角形集合不变 / 末块 #${aqTail ? aqTail.id : "?"} 就是 #${aqFrontId}）`,
  );
  var aqParts3 = aqM3.parts ?? [];
  check(
    aqParts3.length >= 2 && aqParts3.reduce((s, p) => s + p.size, 0) === aqM3.indexCount && aqParts3[0].start === 0 &&
      aqParts3.every((p, i) => i === 0 || p.start === aqParts3[i - 1].start + aqParts3[i - 1].size),
    `重排后部件表仍首尾相接铺满索引表（${aqParts3.map((p) => `${p.id}@${p.start}+${p.size}`).join(" ")}）`,
  );

  // ── 存库重开：骨架与权重都读回来 ──
  await reopen(aqId);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length >= 1`, 90000);
  await waitFor(`/首帧就绪|First frame ready/.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await click(await h.rowCenter("stripe"));
  var aqOpen = await waitFor(`!!document.querySelector('.ed-warp .ed-warp-open')`, 40000).then(() => true, () => false);
  if (!aqOpen) {
    check(false, `重开后找不到「进入操控变形」：树 [${await h.treeNames()}] / 页面错误 [${(await h.errorLines()).join(" ; ")}]`);
  }
  await clickSel(".ed-warp-open");
  await aqPins();
  var aqNotesR = await aqNotes("ed-skel");
  check(/8 根|8 bones/.test(aqNotesR[0] ?? ""), `重开：8 根骨读回来（${aqNotesR[0]}）`);
  check(/2\. spine/.test((await ev(`[...document.querySelectorAll('#ed-inspector .ed-skel-bone')].map((b) => b.textContent).join(" | ")`)) ?? ""), "重开：骨名读回来（第 2 根还是 spine）");
  check((await ev(`document.querySelectorAll('#ed-inspector .ed-wt-target option').length`)) === 8, "重开：权重面板认出盘上 8 骨（骨数对得上，盘上权重可直接用）");
  var aqDR = aqDisk(aqId);
  check(
    aqDR.json?.puppetWarp?.skeleton?.bones?.length === 8 && aqDR.json?.puppetWarp?.weights !== undefined,
    "重开：盘上骨架与权重状态都还在（skeleton.bones / weights）",
  );
  var aqMR = aqMdl(aqDR);
  var aqSlotsR = Array.from(aqMR.boneIdx).filter((v) => v === 2).length;
  check(aqSlotsR === aqSlots2After, `重开：涂抹过的权重没变（骨号 2 的蒙皮槽 ${aqSlotsR}）`);

  var aqErrs = await h.errorLines();
  check(aqErrs.length === 0, `骨架与权重全程控制台无错误${aqErrs.length ? `：${aqErrs.slice(0, 2).join(" / ")}` : ""}`);
  } catch (err) { await hlAbort("AQ", aqName, err); }
}

await skelE2E();

  if (hlState.aborts.length || hlState.skipped) {
    console.log(`\n真机段小结：中断 ${hlState.aborts.length} 段、跳过 ${hlState.skipped} 段`);
    for (const a of hlState.aborts) console.log(`  ✗ ${a.name} —— ${a.msg}`);
  }
}
