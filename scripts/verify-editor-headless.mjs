/**
 * verify-editor 的真浏览器部分（`node scripts/verify-editor.mjs --headless` 调用）。
 *
 * 自起 vite（WE_LIBRARY 指向临时库，保存产物不落进真实壁纸库），真 GPU Chrome：
 *   K. 引擎编辑器控制面：在页面里经公开出口 `api/editor` 另挂一个实例（pkg 形态），
 *      逐个 API 断言数值语义（时钟 / 出图 / 拾取 / 活层 / 热改 / 轮廓 / 位移换算）。
 *   L. 编辑器页端到端（松散形态）：真鼠标 / 键盘事件（CDP Input）驱动 —— 树选中、
 *      检视器热改、旋转柄 / 角点 / 平移拖拽、点选与 Alt 轮换、锁定、复制 / 重排 / 删除、
 *      撤销重做、逐帧、导出 PNG、下载 zip、另存到壁纸库、重新打开、⌘S 覆盖。
 *   Q. 新建端到端：空白 / 纯色 / 图片背景模板，选图与拖入（含 webp 转码）加层，撤销重做，
 *      另存到壁纸库，编辑器重新打开与测试台渲染页播放 —— 判据是 CDP 截图的真实像素。
 *   R. 草稿：编辑后刷新出横幅 → 恢复（新建来源 / 库来源）、丢弃、保存后清除。
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

export async function runEditorHeadless({ check, section, tmpRoot, cleanups, LIB }) {
  const src = path.join(LIB, FIXTURE);
  if (!fs.existsSync(path.join(src, "scene.json")) || !fs.existsSync(path.join(src, "scene.pkg"))) {
    check(false, `夹具 ${FIXTURE} 需要同时有 scene.json 与 scene.pkg（WE_EDITOR_ITEM 可换）`);
    return;
  }
  // 临时库：<fixture> = 完整目录（松散形态优先）；<fixture>-pkg = 只留包（走 pkg 形态）
  const lib = path.join(tmpRoot, "lib-headless");
  fs.cpSync(src, path.join(lib, FIXTURE), { recursive: true });
  const pkgItem = `${FIXTURE}-pkg`;
  fs.mkdirSync(path.join(lib, pkgItem), { recursive: true });
  for (const f of ["project.json", "scene.pkg"]) fs.copyFileSync(path.join(src, f), path.join(lib, pkgItem, f));
  const sceneJson = JSON.parse(fs.readFileSync(path.join(src, "scene.json"), "utf8"));
  const objects = sceneJson.objects;

  const prevLib = process.env.WE_LIBRARY;
  process.env.WE_LIBRARY = lib;
  cleanups.push(() => {
    if (prevLib === undefined) delete process.env.WE_LIBRARY;
    else process.env.WE_LIBRARY = prevLib;
  });
  const port = await new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
  const { createServer } = await import("vite");
  const server = await createServer({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    server: { port, host: "127.0.0.1", strictPort: true, open: false },
    logLevel: "error",
  });
  await server.listen();
  cleanups.push(() => server.close());
  const origin = `http://127.0.0.1:${port}`;

  const { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
  const session = await launchHeadless({ url: "about:blank", task: "verify-editor", width: 1440, height: 900 });
  cleanups.push(() => session.close());
  instrument(session, { width: 1440, height: 900 });
  const cdp = session.pageCdp;
  const ev = (expr, timeoutMs = 60000) => session.evaluate(expr, { awaitPromise: true, timeoutMs });
  const waitFor = (expr, timeoutMs = 60000) => session.waitFor(expr, { timeoutMs });

  // ---- 真输入（CDP Input：产生可信的 pointer / mouse / key 事件，含指针捕获） ----
  const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
  const mouse = (type, x, y, { buttons = 0, modifiers = 0 } = {}) =>
    cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: 1, modifiers });
  const click = async ([x, y], modifiers = 0) => {
    await mouse("mouseMoved", x, y, { modifiers });
    await mouse("mousePressed", x, y, { buttons: 1, modifiers });
    await mouse("mouseReleased", x, y, { modifiers });
    await sleep(60);
  };
  const drag = async ([x0, y0], [x1, y1], modifiers = 0, steps = 10) => {
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
  const KEYS = { z: [90, "KeyZ"], y: [89, "KeyY"], d: [68, "KeyD"], s: [83, "KeyS"], Delete: [46, "Delete"] };
  const key = async (k, modifiers = 0) => {
    const [vk, code] = KEYS[k];
    await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
    await sleep(60);
  };
  const clickSel = async (sel) => {
    const r = await ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
    await click(r);
  };

  // ---- 编辑器页 DOM 状态 ----
  const READY = "/首帧就绪|First frame ready/";
  const SAVED = "/保存用时|Save took/";
  const savedCount = () => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${SAVED}.test(d.textContent)).length`);
  const waitSaved = async (before) => {
    await waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${SAVED}.test(d.textContent)).length > ${before}`, 120000);
    await sleep(200);
  };
  const readyCount = () => ev(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length`);
  const errorLines = () => ev(`[...document.querySelectorAll('#ed-con-body > div.error')].map((d) => d.textContent)`);
  const treeNames = () => ev(`[...document.querySelectorAll('#ed-tree .ed-node .ed-node-name')].map((n) => n.textContent)`);
  const selectedName = () => ev(`document.querySelector('#ed-tree .ed-node.selected .ed-node-name')?.textContent ?? null`);
  const numInputs = () => ev(`[...document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')].map((i) => Number(i.value))`);
  const dirtyTitle = () => ev(`document.querySelector('#ed-doc-title').textContent.startsWith('● ')`);
  const canvasRect = () => ev(`(() => { const r = document.querySelector('#ed-stage canvas:not(#ed-overlay)').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  /** 等一次整场景重挂完成（结构编辑 / 撤销重做 / 重新加载） */
  const waitRemount = async (before) => {
    await waitFor(`[...document.querySelectorAll('#ed-con-body > div')].filter((d) => ${READY}.test(d.textContent)).length > ${before}`);
    await waitFor(`!document.querySelector('#tb-export').disabled`);
    await sleep(150);
  };
  const rowCenter = (name) =>
    ev(`(() => { const n = [...document.querySelectorAll('#ed-tree .ed-node')].find((r) => r.querySelector('.ed-node-name').textContent === ${JSON.stringify(name)}); if (!n) return null; const r = n.getBoundingClientRect(); return [r.left + 40, r.top + r.height / 2]; })()`);
  const rowButton = (name, cls) =>
    ev(`(() => { const n = [...document.querySelectorAll('#ed-tree .ed-node')].find((r) => r.querySelector('.ed-node-name').textContent === ${JSON.stringify(name)}); const b = n?.querySelector(${JSON.stringify(cls)}); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  /** 检视器数值框：focus（记 before）→ 改值 → input（热改）→ change（入栈） */
  const setInputs = (values) =>
    ev(`(() => {
      const ins = [...document.querySelectorAll('#ed-inspector fieldset.ed-form input[type=number]')];
      const v = ${JSON.stringify(values)};
      ins[0].focus();
      for (const [i, x] of Object.entries(v)) { ins[i].value = String(x); ins[i].dispatchEvent(new Event('input', { bubbles: true })); }
      for (const i of Object.keys(v)) ins[i].dispatchEvent(new Event('change', { bubbles: true }));
      ins[0].blur();
      return true;
    })()`);
  /** 拦截页面的 <a download>.click()：返回 { name, base64 } */
  const captureDownload = async (trigger) => {
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
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html?item=${FIXTURE}` });
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === ${objects.length}`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  await waitFor(`${READY}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await sleep(500);
  const cr = await canvasRect();

  // ════════════════════════════════════════════════════════════════════════
  // K. 引擎编辑器控制面（同页旁挂 pkg 形态实例，尺寸与编辑器画布一致）
  // ════════════════════════════════════════════════════════════════════════
  section(`K. 引擎编辑器控制面（${pkgItem}，pkg 形态，${Math.round(cr.w)}×${Math.round(cr.h)}）`);
  const k = await ev(`(async () => {
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
  const top = k.top;
  const topObj = objects.find((o) => o.id === top);
  const vec = (s) => String(s).trim().split(/\s+/).map(Number);
  const [ox, oy] = vec(topObj.origin);
  const [sx] = vec(topObj.scale);
  check(near(k.props[top].origin[0], ox, 1e-3) && near(k.props[top].origin[1], oy, 1e-3) && near(k.props[top].scale[0], sx, 1e-3), "getLayerProps：变换与 scene.json 一致");
  const cssPerWorld = cr.w / 1920;
  const anchorTop = k.outline[top].anchor;
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
  // L. 编辑器页端到端
  // ════════════════════════════════════════════════════════════════════════
  section(`L. 编辑器页端到端（${FIXTURE}，松散形态）`);
  check(JSON.stringify(await treeNames()) === JSON.stringify(objects.map((o) => o.name)), "图层树与 scene.json 一致");
  check(/松散|loose/i.test(await ev(`document.querySelector('#st-form').textContent`)), "状态栏显示松散形态");
  const topName = topObj.name;
  const toPage = ([x, y]) => [cr.x + x, cr.y + y];

  // 树选中 + 检视器热改（把顶层挪到画布中心、缩到 0.3，手柄全部落在画面内）
  await click(await rowCenter(topName));
  check((await selectedName()) === topName, "点树行选中图层");
  check(!(await dirtyTitle()), "未编辑时标题无脏标记");
  await setInputs({ 0: 960, 1: 540, 3: 0.3, 4: 0.3 });
  await sleep(200);
  let v = await numInputs();
  check(v[0] === 960 && v[1] === 540 && v[3] === 0.3, "检视器数值框热改");
  check(await dirtyTitle(), "编辑后标题出现脏标记");
  check(!(await ev(`document.querySelector('#tb-undo').disabled`)), "编辑后撤销可用");

  // 手柄几何：旁挂实例同尺寸、同 fit，同样的属性 → 同样的轮廓
  const geo = await ev(`(async () => {
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
  const c = geo.corners;
  const anchor = geo.anchor;
  const mid = [(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2];
  const ctr = [c.reduce((s, p) => s + p[0], 0) / 4, c.reduce((s, p) => s + p[1], 0) / 4];
  const len = Math.hypot(mid[0] - ctr[0], mid[1] - ctr[1]) || 1;
  const rotHandle = [mid[0] + ((mid[0] - ctr[0]) / len) * 22, mid[1] + ((mid[1] - ctr[1]) / len) * 22];

  // 悬停光标
  await mouse("mouseMoved", ...toPage(rotHandle));
  await sleep(120);
  check((await ev(`document.querySelector('#ed-stage').dataset.cursor`)) === "rotate", "悬停旋转柄：光标切到旋转");
  await mouse("mouseMoved", ...toPage(c[2]));
  await sleep(120);
  check((await ev(`document.querySelector('#ed-stage').dataset.cursor`)) === "scale", "悬停角点：光标切到缩放");

  // 旋转柄：绕锚点顺时针拖 90°
  const r0 = [rotHandle[0] - anchor[0], rotHandle[1] - anchor[1]];
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
  const to2 = [anchor[0] + (c[2][0] - anchor[0]) * 2, anchor[1] + (c[2][1] - anchor[1]) * 2];
  await drag(toPage(c[2]), toPage(to2), MOD.shift);
  v = await numInputs();
  check(near(v[3], 0.6, 0.02) && near(v[4], 0.6, 0.02), `角点 Shift 外拖一倍 → 缩放 ${v[3]} / ${v[4]}`);

  // 平移：从层内部拖 (+60, +30) CSS 像素
  const before = await numInputs();
  const inside = [anchor[0] + 5, anchor[1] + 5];
  await drag(toPage(inside), toPage([inside[0] + 60, inside[1] + 30]));
  v = await numInputs();
  check(near(v[0] - before[0], 60 / cssPerWorld, 2) && near(v[1] - before[1], -30 / cssPerWorld, 2), `平移拖拽 → origin Δ(${(v[0] - before[0]).toFixed(1)}, ${(v[1] - before[1]).toFixed(1)})`);
  const movedAnchor = [anchor[0] + 60, anchor[1] + 30];

  // 画面点选 + Alt 轮换
  await click(toPage([cr.w - 3, 3]));
  const picked1 = await selectedName();
  await click(toPage(movedAnchor));
  check((await selectedName()) === topName, "点画面选中最上层");
  await click(toPage(movedAnchor), MOD.alt);
  const altPicked = await selectedName();
  check(altPicked !== topName && altPicked !== null, `Alt+点击同一位置轮换到下一层（${altPicked}）`);
  check(picked1 !== topName, "点别处不会误选到被移走的层");

  // 锁定：不可点选、不可拖、检视器只读
  await click(await rowCenter(topName));
  await click(await rowButton(topName, ".ed-lock"));
  check(await ev(`document.querySelector('#ed-inspector fieldset.ed-form').disabled`), "锁定后检视器只读");
  const lockedBefore = await numInputs();
  await drag(toPage(movedAnchor), toPage([movedAnchor[0] + 80, movedAnchor[1]]));
  await click(await rowCenter(topName));
  check(JSON.stringify(await numInputs()) === JSON.stringify(lockedBefore), "锁定层拖不动");
  await click(toPage(movedAnchor));
  check((await selectedName()) !== topName, "锁定层不参与画面点选");
  await click(await rowCenter(topName));
  await click(await rowButton(topName, ".ed-lock"));
  check(!(await ev(`document.querySelector('#ed-inspector fieldset.ed-form').disabled`)), "解锁后恢复可编辑");

  // 结构编辑：复制 / 重排 / 删除 + 撤销重做（整场景重挂）
  const n0 = objects.length;
  let rc = await readyCount();
  await clickSel("#ly-dup");
  await waitRemount(rc);
  let names = await treeNames();
  check(names.length === n0 + 1 && names.some((n) => n.startsWith(topName) && n !== topName), `复制图层：树多一行（${names.at(-1)}）`);
  check(new RegExp(`${n0 + 1}`).test(await ev(`document.querySelector('#st-layers').textContent`)), "复制后引擎重挂出的图层数 +1");
  const copyName = await selectedName();
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
  const t0 = await ev(`parseFloat(document.querySelector('#tl-time').textContent)`);
  await clickSel("#tl-next");
  await sleep(200);
  const t1 = await ev(`parseFloat(document.querySelector('#tl-time').textContent)`);
  check(await ev(`!document.querySelector('#tb-play .ic-play').hasAttribute('hidden')`), "逐帧时自动暂停");
  check(t1 > t0 || near(t1, t0 + 1 / 60, 0.02), `下一帧推进时钟（${t0} → ${t1}）`);

  // 导出 PNG（场景原生分辨率）
  const png = await captureDownload(() => clickSel("#tb-export"));
  const pngBuf = Buffer.from(png.base64, "base64");
  check(/\.png$/.test(png.name) && pngBuf.readUInt32BE(16) === 1920 && pngBuf.readUInt32BE(20) === 1080, `导出 PNG：1920×1080（${png.name}）`);

  // 下载 zip
  const zipDl = await captureDownload(async () => {
    await clickSel("#tb-save");
    await clickSel("#save-zip");
  });
  const zipPath = path.join(tmpRoot, "e2e.zip");
  fs.writeFileSync(zipPath, Buffer.from(zipDl.base64, "base64"));
  const ut = spawnSync("unzip", ["-t", zipPath], { encoding: "utf8" });
  const ul = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  const zipNames = (ul.stdout || "").trim().split("\n");
  check(ut.status === 0, "下载的 zip 通过 unzip -t");
  check(["scene.json", "project.json", "preview.jpg"].every((n) => zipNames.includes(n)) && zipNames.some((n) => n.startsWith("materials/")), `zip 内含入口 / 工程 / 封面 / 资源（${zipNames.length} 个）`);
  await waitFor(`!document.querySelector('#tb-save').disabled`);

  // 另存到壁纸库
  const libBefore = new Set(fs.readdirSync(lib));
  let sc = await savedCount();
  await clickSel("#tb-save");
  check(await ev(`!document.querySelector('#save-lib').hidden`), "壁纸库可用时显示「另存到壁纸库」");
  await clickSel("#save-lib");
  await waitSaved(sc);
  const saved = fs.readdirSync(lib).filter((n) => !libBefore.has(n));
  check(saved.length === 1 && /^editor-/.test(saved[0]), `新库条目（${saved[0]}）`);
  const itemDir = path.join(lib, saved[0]);
  const sScene = JSON.parse(fs.readFileSync(path.join(itemDir, "scene.json"), "utf8"));
  const sProject = JSON.parse(fs.readFileSync(path.join(itemDir, "project.json"), "utf8"));
  check(fs.existsSync(path.join(itemDir, ".webwallgl-editor")), "条目带编辑器标记");
  check(sScene.objects.length === n0 + 1, "盘上 scene.json 含副本层");
  const sTop = sScene.objects.find((o) => o.name === topName);
  const [sx1, , ] = vec(typeof sTop.scale === "object" ? sTop.scale.value : sTop.scale);
  const [ox1] = vec(typeof sTop.origin === "object" ? sTop.origin.value : sTop.origin);
  check(near(sx1, 0.6, 0.02) && near(ox1, before[0] + 60 / cssPerWorld, 2), "盘上 scene.json 含拖拽 / 缩放结果");
  check(sProject.type === "scene" && sProject.file === "scene.json" && sProject.preview === "preview.jpg", "project.json 指向文档与新封面");
  const jpg = fs.readFileSync(path.join(itemDir, "preview.jpg"));
  check(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 2000, `封面是有效 JPEG（${(jpg.length / 1024).toFixed(0)} KB）`);
  check(!(await dirtyTitle()), "保存后脏标记清除");
  check(await ev(`[...document.querySelectorAll('#ed-lib-list li .sub')].some((s) => s.textContent.includes(${JSON.stringify(saved[0])}))`), "保存后库列表刷新出新条目");

  // ⌘S：重复上次目标，覆盖同一条目
  await click(await rowCenter(copyName));
  rc = await readyCount();
  await key("Delete");
  await waitRemount(rc);
  sc = await savedCount();
  await key("s", MOD.meta);
  await waitSaved(sc);
  const afterCmdS = fs.readdirSync(lib).filter((n) => !libBefore.has(n));
  const sScene2 = JSON.parse(fs.readFileSync(path.join(itemDir, "scene.json"), "utf8"));
  check(afterCmdS.length === 1 && sScene2.objects.length === n0, "⌘S 覆盖同一库条目（不新建）");

  const errs1 = await errorLines();
  check(errs1.length === 0, `编辑全程控制台无错误${errs1.length ? `：${errs1.slice(0, 2).join(" / ")}` : ""}`);

  // 重新打开保存产物
  await cdp.send("Page.navigate", { url: `${origin}/editor/index.html?item=${saved[0]}` });
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === ${n0}`, 90000);
  await waitFor(`${READY}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  check(JSON.stringify(await treeNames()) === JSON.stringify(sScene2.objects.map((o) => o.name)), "重新打开：图层树与盘上 scene.json 一致");
  await click(await rowCenter(topName));
  v = await numInputs();
  check(near(v[3], 0.6, 0.02) && near(v[0], ox1, 0.01), "重新打开：引擎读到保存的变换");
  const errs2 = await errorLines();
  check(errs2.length === 0, `重新打开无错误${errs2.length ? `：${errs2.slice(0, 2).join(" / ")}` : ""}`);

  await session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/reopened.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/reopened.jpg`);

  await runCreateAndDraft({ check, section, tmpRoot, lib, origin, cdp, ev, waitFor, click, key, clickSel, MOD, helpers: { readyCount, waitRemount, savedCount, waitSaved, treeNames, selectedName, numInputs, setInputs, dirtyTitle, canvasRect, rowCenter, errorLines }, objects, session });

  await session.close();
  await server.close();
}

/** 上半 top、下半 bottom 的 RGB PNG（无依赖编码：IHDR + 单块 IDAT + IEND） */
export function stripePng(w, h, top, bottom) {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const c = y < h / 2 ? top : bottom;
    for (let x = 0; x < w; x++) raw.set(c, y * stride + 1 + x * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
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

/**
 * Q. 新建端到端 + R. 草稿。判据只看 DOM、盘上产物与真实像素（CDP 截图），
 * 不读编辑器页任何内部状态。
 */
async function runCreateAndDraft(ctx) {
  const { check, section, tmpRoot, lib, origin, cdp, ev, waitFor, click, key, clickSel, MOD, helpers: h, objects } = ctx;
  const RED = [220, 30, 30];
  const BLUE = [30, 30, 220];
  const BG = "#336699";
  const BG_RGB = [0x33, 0x66, 0x99];
  const stripePath = path.join(tmpRoot, "stripe.png");
  fs.writeFileSync(stripePath, stripePng(400, 200, RED, BLUE));

  await cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
  const setFiles = async (sel, files) => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: sel });
    await cdp.send("DOM.setFileInputFiles", { nodeId, files });
  };
  /** 页面坐标处 4×4 平均色（真实合成结果，经 CDP 截图） */
  const pixelAt = async ([x, y]) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", clip: { x: x - 2, y: y - 2, width: 4, height: 4, scale: 1 } });
    return ev(`(async () => {
      const bmp = await createImageBitmap(await (await fetch('data:image/png;base64,${data}')).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height); const g = c.getContext('2d'); g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data; const s = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) { s[0] += d[i]; s[1] += d[i + 1]; s[2] += d[i + 2]; }
      return s.map((v) => Math.round(v / (d.length / 4)));
    })()`);
  };
  const close = (a, b, eps) => a.every((v, i) => Math.abs(v - b[i]) <= eps);
  const isRed = (c) => c[0] > 170 && c[1] < 80 && c[2] < 80;
  const isBlue = (c) => c[2] > 170 && c[0] < 80 && c[1] < 80;
  const isGreen = (c) => c[1] > 170 && c[0] < 80 && c[2] < 80;
  const bannerShown = () => ev(`!document.querySelector('#ed-draft').hidden`);
  const EDITOR = `${origin}/editor/index.html`;
  const gotoEditor = async (query = "") => {
    await cdp.send("Page.navigate", { url: `${EDITOR}${query}` });
    await waitFor(`document.readyState === 'complete' && !!document.querySelector('#ed-lib-list li')`, 90000);
  };
  /** 编辑器画布上世界坐标（y 朝上）→ 页面坐标；场景 16:9 与舞台同比例 */
  const worldToPage = (cr, [wx, wy], W = 1920, H = 1080) => {
    const k = Math.max(cr.w / W, cr.h / H);
    return [cr.x + cr.w / 2 + (wx - W / 2) * k, cr.y + cr.h / 2 - (wy - H / 2) * k];
  };
  const newBlank = async (color) => {
    await clickSel("#tb-new");
    await ev(`(() => { document.querySelector('#new-res').value = '1920x1080'; document.querySelector('#new-color').value = '${color}'; return true; })()`);
    const rc = await h.readyCount();
    await clickSel("#new-blank");
    await h.waitRemount(rc);
  };
  const addImage = async (file) => {
    const rc = await h.readyCount();
    await clickSel("#ly-add");
    await setFiles("#in-image", [file]);
    await h.waitRemount(rc);
  };

  // ════════════════════════════════════════════════════════════════════════
  section("Q. 新建端到端（模板 → 图片层 → 存库 → 编辑器与测试台播放）");
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  check(!(await ev(`document.querySelector('#tb-new').disabled`)), "「新建」按钮可用");
  await clickSel("#tb-new");
  check(await ev(`!document.querySelector('#new-menu').hidden`), "点「新建」弹出模板菜单");
  check((await ev(`[...document.querySelectorAll('#new-res option')].map((o) => o.value)`)).join() === "1920x1080,2560x1440,3840x2160,1080x1920", "分辨率预设齐全");
  await clickSel("#tb-new");
  check(await ev(`document.querySelector('#new-menu').hidden`), "再点一次收起菜单");

  await newBlank(BG);
  const cr = await h.canvasRect();
  check((await h.treeNames()).length === 0 && /0/.test(await ev(`document.querySelector('#st-layers').textContent`)), "空白模板：图层树为空、引擎 0 层");
  check(/1920×1080/.test(await ev(`document.querySelector('#st-res').textContent`)) && /松散|loose/i.test(await ev(`document.querySelector('#st-form').textContent`)), "状态栏：1920×1080、松散形态");
  check(/未命名|Untitled/.test(await ev(`document.querySelector('#ed-doc-title').textContent`)) && !(await h.dirtyTitle()), "标题 = 未命名壁纸，新建即干净（无脏标记）");
  const bg0 = await pixelAt(worldToPage(cr, [960, 540]));
  check(close(bg0, BG_RGB, 10), `画面 = 所选背景色（期望 ${BG_RGB}，实得 ${bg0}）`);
  check(!(await ev(`document.querySelector('#ly-add').disabled`)) && !(await ev(`document.querySelector('#tb-save').disabled`)), "新建后「添加图片」「保存」可用");

  // 选图加层：400×200，上红下蓝，放在中心、不缩放
  await addImage(stripePath);
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && (await h.selectedName()) === "stripe", "选图后树里多一层「stripe」并选中");
  check(await h.dirtyTitle(), "加图后出现脏标记");
  let v = await h.numInputs();
  check(v[0] === 960 && v[1] === 540 && v[3] === 1, `新图层在场景中心、原尺寸（origin ${v[0]},${v[1]} scale ${v[3]}）`);
  const topPt = worldToPage(cr, [960 + 150, 540 + 50]);
  const botPt = worldToPage(cr, [960 + 150, 540 - 50]);
  const outPt = worldToPage(cr, [200, 200]);
  let cTop = await pixelAt(topPt);
  let cBot = await pixelAt(botPt);
  check(isRed(cTop) && isBlue(cBot), `引擎真画出图片且不上下颠倒（上 ${cTop} / 下 ${cBot}）`);
  check(close(await pixelAt(outPt), BG_RGB, 10), "图片外仍是背景色");

  // 撤销 / 重做加层
  let rc = await h.readyCount();
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
  const cMid = await pixelAt(worldToPage(cr, [1000, 500]));
  cTop = await pixelAt(topPt);
  check(isGreen(cMid) && isRed(cTop), `新层盖在上面，旧层未被遮住的部分照常显示（中 ${cMid} / 旁 ${cTop}）`);

  // 存进库
  const libBefore = new Set(fs.readdirSync(lib));
  let sc = await h.savedCount();
  await clickSel("#tb-save");
  await clickSel("#save-lib");
  await h.waitSaved(sc);
  const saved = fs.readdirSync(lib).filter((n) => !libBefore.has(n));
  check(saved.length === 1, `另存到壁纸库：新条目 ${saved[0]}`);
  const dir = path.join(lib, saved[0]);
  const scene = JSON.parse(fs.readFileSync(path.join(dir, "scene.json"), "utf8"));
  check(scene.general.clearcolor === "0.200 0.400 0.600" && scene.objects.length === 2, "盘上 scene.json：背景色 + 两个图片层");
  const need = ["models/editor/stripe.json", "materials/editor/stripe.json", "materials/editor/stripe.png", "models/editor/green.json", "materials/editor/green.json", "materials/editor/green.png", "preview.jpg", "project.json"];
  check(need.every((f) => fs.existsSync(path.join(dir, f))), "盘上资源齐全（两组模型 / 材质 / 源图 + 封面 + 工程）");
  check(Buffer.compare(fs.readFileSync(path.join(dir, "materials/editor/stripe.png")), fs.readFileSync(stripePath)) === 0, "png 源图逐字节原样保存");
  const g = fs.readFileSync(path.join(dir, "materials/editor/green.png"));
  check(g.readUInt32BE(0) === 0x89504e47 && g.readUInt32BE(16) === 200, "webp 转成 png 保存（200×200）");
  check(!fs.readdirSync(path.join(dir, "materials/editor")).some((n) => n.endsWith(".webp")), "不留引擎读不了的 webp");
  const errsQ = await h.errorLines();
  check(errsQ.length === 0, `新建全程控制台无错误${errsQ.length ? `：${errsQ.slice(0, 2).join(" / ")}` : ""}`);

  // 编辑器重新打开
  await gotoEditor(`?item=${saved[0]}`);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(`${"/首帧就绪|First frame ready/"}.test(document.querySelector('#ed-con-body').textContent)`, 90000);
  await new Promise((r) => setTimeout(r, 400));
  const cr2 = await h.canvasRect();
  check(isRed(await pixelAt(worldToPage(cr2, [1110, 590]))) && isGreen(await pixelAt(worldToPage(cr2, [960, 540]))), "编辑器重新打开：画面与保存前一致");

  // 测试台渲染页播放（与资源管理器同一条加载链）
  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${saved[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vp = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchRect = { x: 0, y: 0, w: vp.w, h: vp.h };
  const layerNames = await ev(`window.__sceneLayers.map((l) => l.name)`);
  check(JSON.stringify(layerNames) === JSON.stringify(["stripe", "green"]), "测试台渲染页：两层都装配出来");
  const bTop = await pixelAt(worldToPage(benchRect, [1110, 590]));
  const bBot = await pixelAt(worldToPage(benchRect, [1110, 490]));
  const bMid = await pixelAt(worldToPage(benchRect, [960, 540]));
  const bOut = await pixelAt(worldToPage(benchRect, [300, 540]));
  check(isRed(bTop) && isBlue(bBot) && isGreen(bMid), `测试台渲染页：图片内容与位置正确（上 ${bTop} / 下 ${bBot} / 中 ${bMid}）`);
  check(close(bOut, BG_RGB, 10), `测试台渲染页：背景色正确（${bOut}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/new-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/new-in-bench.jpg`);

  // 「以图片为背景」模板：铺满（cover），新建即带内容
  await gotoEditor();
  await clickSel("#tb-new");
  const rcBg = await h.readyCount();
  await clickSel("#new-image");
  await setFiles("#in-image", [stripePath]);
  await h.waitRemount(rcBg);
  check(await ev(`document.querySelector('#new-menu').hidden`), "选完图片后模板菜单自动收起");
  const crBg = await h.canvasRect();
  const bgUp = await pixelAt(worldToPage(crBg, [150, 900]));
  const bgDown = await pixelAt(worldToPage(crBg, [150, 150]));
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && (await h.dirtyTitle()), "图片背景模板：一层背景图、带脏标记（有内容可丢）");
  check(isRed(bgUp) && isBlue(bgDown), `图片背景铺满整个场景（左上 ${bgUp} / 左下 ${bgDown}）`);
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);

  // ════════════════════════════════════════════════════════════════════════
  section("R. 草稿（IndexedDB）");
  // 新建来源：加图后刷新 → 恢复
  await gotoEditor();
  check(!(await bannerShown()), "保存过后再打开：没有草稿横幅");
  await newBlank("#202020");
  await addImage(stripePath);
  await new Promise((r) => setTimeout(r, 1500));
  await gotoEditor();
  await waitFor(`!document.querySelector('#ed-draft').hidden`, 20000);
  check(/未命名|Untitled/.test(await ev(`document.querySelector('#ed-draft-text').textContent`)), "刷新后出现草稿横幅（标题正确）");
  let rc2 = await h.readyCount();
  await clickSel("#draft-restore");
  await h.waitRemount(rc2);
  check(JSON.stringify(await h.treeNames()) === JSON.stringify(["stripe"]) && (await h.dirtyTitle()), "恢复新建草稿：图层回来、标记为未保存");
  const cr3 = await h.canvasRect();
  check(isRed(await pixelAt(worldToPage(cr3, [1110, 590]))) && close(await pixelAt(worldToPage(cr3, [200, 200])), [0x20, 0x20, 0x20], 10), "恢复后画面一致（图片字节从草稿里来，背景色保留）");
  check(!(await bannerShown()), "恢复后横幅收起");

  // 丢弃
  await gotoEditor();
  await waitFor(`!document.querySelector('#ed-draft').hidden`, 20000);
  await clickSel("#draft-discard");
  check(!(await bannerShown()), "点丢弃：横幅收起");
  await gotoEditor();
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await bannerShown()), "丢弃后刷新：不再提示");

  // 库来源：热改后刷新 → 恢复 → 保存后清除
  await gotoEditor(`?item=${FIXTURE}`);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === ${objects.length}`, 90000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  const topName = objects[objects.length - 1].name;
  await click(await h.rowCenter(topName));
  await h.setInputs({ 0: 777, 1: 333 });
  await new Promise((r) => setTimeout(r, 1500));
  await gotoEditor(`?item=${FIXTURE}`);
  await waitFor(`!document.querySelector('#ed-draft').hidden`, 20000);
  await waitFor(`!document.querySelector('#tb-export').disabled`, 90000);
  rc2 = await h.readyCount();
  await clickSel("#draft-restore");
  await h.waitRemount(rc2);
  await click(await h.rowCenter(topName));
  v = await h.numInputs();
  check(near(v[0], 777, 1e-6) && near(v[1], 333, 1e-6) && (await h.dirtyTitle()), `恢复库来源草稿：热改回来（origin ${v[0]},${v[1]}）`);
  sc = await h.savedCount();
  await key("s", MOD.meta);
  await clickSel("#save-lib");
  await h.waitSaved(sc);
  await gotoEditor();
  await new Promise((r) => setTimeout(r, 1500));
  check(!(await bannerShown()), "保存后草稿被清除（刷新不再提示）");
  const errsR = await h.errorLines();
  check(errsR.length === 0, `草稿流程无错误${errsR.length ? `：${errsR.slice(0, 2).join(" / ")}` : ""}`);

  // ════════════════════════════════════════════════════════════════════════
  section("T. 效果库端到端（空白 → 图片层 + 2 个内置效果 → 存库 → 测试台出帧一致）");
  const fxNames = () => ev(`[...document.querySelectorAll('.ed-fx-item')].map((e) => e.dataset.fxId)`);
  const fxAct = async (js) => {
    const r0 = await h.readyCount();
    await ev(`(() => { ${js}; return true; })()`);
    await h.waitRemount(r0);
  };
  const fxAdd = (id) => fxAct(`const s = document.querySelector('#fx-add'); s.value = '${id}'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
  const fxSet = (i, param, value) =>
    fxAct(`const el = document.querySelector('.ed-fx-item[data-fx-index="${i}"] input[data-param="${param}"]'); el.value = '${value}'; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  const fxBtn = (i, cls) => fxAct(`document.querySelector('.ed-fx-item[data-fx-index="${i}"] .${cls}').click()`);
  const undoRedo = async (shift) => {
    const r0 = await h.readyCount();
    await key("z", shift ? MOD.meta | MOD.shift : MOD.meta);
    await h.waitRemount(r0);
  };

  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#000000");
  await addImage(stripePath);
  const crT = await h.canvasRect();
  const tTop = worldToPage(crT, [1110, 590]);
  const tBot = worldToPage(crT, [1110, 490]);
  const tOut = worldToPage(crT, [300, 540]);
  check(await ev(`!!document.querySelector('.ed-fx') && !document.querySelector('#fx-add').disabled && document.querySelectorAll('#fx-add option').length === 8`), "选中图片层：检视器有「效果」分组，下拉列出 7 个内置效果");
  check((await fxNames()).length === 0, "初始无效果");

  await fxAdd("tint");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint"]) && (await h.selectedName()) === "stripe", "添加「颜色叠加」：列表一项，选中仍是该层");
  const tint0 = await pixelAt(tTop);
  const tintWant = RED.map((c, i) => Math.round(c * 0.5 + [255, 115, 51][i] * 0.5));
  check(close(tint0, tintWant, 6), `缺省橙色 50% 叠在红色上（期望 ${tintWant}，实得 ${tint0}）`);
  await fxSet(0, "color", "#00ff00");
  await fxSet(0, "amount", "1");
  const g1 = await pixelAt(tTop);
  const g2 = await pixelAt(tBot);
  check(isGreen(g1) && isGreen(g2), `改成绿色、强度 1：上下两半都变绿（上 ${g1} / 下 ${g2}）`);
  check(await ev(`document.querySelector('.ed-fx-item[data-fx-index="0"] input[data-param="amount"]').value === '1' && document.querySelector('.ed-fx-item[data-fx-index="0"] input[data-param="color"]').value === '#00ff00'`), "重挂后面板显示改后的参数");

  await fxAdd("adjust");
  await fxSet(1, "brightness", "-0.5");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint", "adjust"]), "第二个效果「色彩调整」排在后面");
  const dim = await pixelAt(tTop);
  check(dim[0] < 30 && dim[2] < 30 && dim[1] > 100 && dim[1] < 160, `效果链串联：先绿再压暗一半（实得 ${dim}）`);
  check(close(await pixelAt(tOut), [0, 0, 0], 8), "效果只作用在图层上，背景不受影响");

  await fxBtn(1, "ed-fx-up");
  check(JSON.stringify(await fxNames()) === JSON.stringify(["adjust", "tint"]), "上移：顺序对调");
  const swapped = await pixelAt(tTop);
  check(isGreen(swapped) && swapped[1] > 200, `先压暗再整色替换成绿 → 纯绿（实得 ${swapped}），顺序真的影响出帧`);
  await undoRedo(false);
  check(JSON.stringify(await fxNames()) === JSON.stringify(["tint", "adjust"]) && close(await pixelAt(tTop), dim, 12), "撤销上移：顺序与画面复原");

  await fxBtn(1, "ed-fx-eye");
  const off = await pixelAt(tTop);
  check(await ev(`document.querySelector('.ed-fx-item[data-fx-index="1"]').classList.contains('hidden-layer')`) && isGreen(off) && off[1] > 200, `停用「色彩调整」：画面回到亮绿（${off}）`);
  await undoRedo(false);
  check(close(await pixelAt(tTop), dim, 12), "撤销停用：压暗回来");

  await fxBtn(1, "ed-fx-del");
  check((await fxNames()).length === 1 && isGreen(await pixelAt(tTop)), "移除第二个效果");
  await undoRedo(false);
  check((await fxNames()).length === 2 && close(await pixelAt(tTop), dim, 12), "撤销移除：效果与参数一并回来");
  const editorTop = await pixelAt(tTop);
  const editorBot = await pixelAt(tBot);

  const libBeforeT = new Set(fs.readdirSync(lib));
  let scT = await h.savedCount();
  await clickSel("#tb-save");
  await clickSel("#save-lib");
  await h.waitSaved(scT);
  const savedT = fs.readdirSync(lib).filter((n) => !libBeforeT.has(n));
  check(savedT.length === 1, `另存到壁纸库：新条目 ${savedT[0]}`);
  const dirT = path.join(lib, savedT[0]);
  const sceneT = JSON.parse(fs.readFileSync(path.join(dirT, "scene.json"), "utf8"));
  const effs = sceneT.objects[0]?.effects ?? [];
  check(effs.length === 2 && effs[0].file === "effects/wwgl_tint/effect.json" && effs[1].file === "effects/wwgl_adjust/effect.json", "盘上 scene.json：图层带两条效果，顺序正确");
  check(effs[0].passes[0].constantshadervalues.color === "0 1 0" && effs[0].passes[0].constantshadervalues.amount === 1 && effs[1].passes[0].constantshadervalues.brightness === -0.5, "盘上参数：颜色 \"0 1 0\"、强度 1、亮度 -0.5");
  const fxFiles = ["tint", "adjust"].flatMap((id) => [`effects/wwgl_${id}/effect.json`, `materials/effects/wwgl_${id}.json`, `shaders/effects/wwgl_${id}.frag`, `shaders/effects/wwgl_${id}.vert`]);
  check(fxFiles.every((f) => fs.existsSync(path.join(dirT, f))), "盘上效果文件齐全（两个效果各四件，产物自包含）");
  check(!fs.existsSync(path.join(dirT, "effects")) || fs.readdirSync(path.join(dirT, "effects")).length === 2, "没用到的效果不进产物");
  const errsT = await h.errorLines();
  check(errsT.length === 0, `效果编辑全程控制台无错误${errsT.length ? `：${errsT.slice(0, 2).join(" / ")}` : ""}`);

  await gotoEditor(`?item=${savedT[0]}`);
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
  const vpT = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchT = { x: 0, y: 0, w: vpT.w, h: vpT.h };
  const bTopT = await pixelAt(worldToPage(benchT, [1110, 590]));
  const bBotT = await pixelAt(worldToPage(benchT, [1110, 490]));
  const bOutT = await pixelAt(worldToPage(benchT, [300, 540]));
  check(close(bTopT, editorTop, 12) && close(bBotT, editorBot, 12), `★ 测试台出帧与编辑器预览一致（测试台 ${bTopT} / ${bBotT}，编辑器 ${editorTop} / ${editorBot}）`);
  check(close(bOutT, [0, 0, 0], 8), "测试台：背景不受效果影响");
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/effects-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/effects-in-bench.jpg`);

  // ════════════════════════════════════════════════════════════════════════
  section("U. 脚本面板端到端（预检 → 应用 → 运行期错误回显 → 撤销 → 存库 → 测试台）");
  const scSel = (target) => `.ed-script[data-target="${target}"]`;
  const scType = async (target, src) => {
    await ev(`(() => { const ta = document.querySelector('${scSel(target)} .ed-script-src'); ta.value = ${JSON.stringify(src)}; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await new Promise((r) => setTimeout(r, 300));
  };
  const scStatus = (target) => ev(`(() => { const s = document.querySelector('${scSel(target)} .ed-script-status'); return { cls: s.className, text: s.textContent }; })()`);
  const scApply = async (target) => {
    const r0 = await h.readyCount();
    await ev(`(() => { document.querySelector('${scSel(target)} .ed-script-apply').click(); return true; })()`);
    await h.waitRemount(r0);
  };
  const BGU = [0x20, 0x20, 0x20];
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#202020");
  await addImage(stripePath);
  const crU = await h.canvasRect();
  const uTop = worldToPage(crU, [1110, 590]);
  check(await ev(`!!document.querySelector('.ed-scripts') && document.querySelectorAll('.ed-script').length === 0 && !document.querySelector('#script-add').disabled`), "检视器有「脚本」分组，图片层初始无脚本、可添加");
  check((await ev(`[...document.querySelectorAll('#script-add option')].map((o) => o.value).filter(Boolean)`)).join() === "origin,scale,angles,visible,alpha,color,brightness", "图片层可加脚本的字段列表");

  await fxAct(`const s = document.querySelector('#script-add'); s.value = 'alpha'; s.dispatchEvent(new Event('change', { bubbles: true }))`);
  check(await ev(`!!document.querySelector('${scSel("alpha")}') && /export function update\\(value\\)/.test(document.querySelector('${scSel("alpha")} .ed-script-src').value)`), "添加 alpha 脚本：出现编辑框，内容为 update(value) 模板");
  let st = await scStatus("alpha");
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
  const issueText = await ev(`document.querySelector('${scSel("alpha")} .ed-script-issues').textContent`);
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
  const half = await pixelAt(uTop);
  const halfWant = RED.map((c, i) => Math.round(c * 0.5 + BGU[i] * 0.5));
  check(close(half, halfWant, 14), `return 0.5：半透明叠在背景上（期望 ≈${halfWant}，实得 ${half}）`);
  check(await ev(`document.querySelector('${scSel("alpha")} .ed-script-issues').hidden`), "重挂后旧错误清空（登记表随装配重建）");

  const libBeforeU = new Set(fs.readdirSync(lib));
  const scU = await h.savedCount();
  await clickSel("#tb-save");
  await clickSel("#save-lib");
  await h.waitSaved(scU);
  const savedU = fs.readdirSync(lib).filter((n) => !libBeforeU.has(n));
  const sceneU = JSON.parse(fs.readFileSync(path.join(lib, savedU[0], "scene.json"), "utf8"));
  const alphaU = sceneU.objects.find((o) => o.name === "stripe")?.alpha;
  check(alphaU && /return 0\.5;/.test(alphaU.script) && alphaU.value === 1, `盘上 scene.json：alpha 包装为 {script, value: 1}（${JSON.stringify(alphaU)?.slice(0, 60)}）`);
  const errsU = (await h.errorLines()).filter((l) => !/alpha' 失败/.test(l));
  check(errsU.length === 0, `脚本流程除故意制造的错误外无错误${errsU.length ? `：${errsU.slice(0, 2).join(" / ")}` : ""}`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedU[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vpU = await ev(`({ w: innerWidth, h: innerHeight })`);
  const bHalf = await pixelAt(worldToPage({ x: 0, y: 0, w: vpU.w, h: vpU.h }, [1110, 590]));
  check(close(bHalf, half, 12), `测试台：脚本照样运行，出帧与编辑器一致（测试台 ${bHalf} / 编辑器 ${half}）`);

  // ════════════════════════════════════════════════════════════════════════
  section("V. 用户属性端到端（声明 → 绑定 → 拖值热更 → 撤销 → combo 显隐 → 删除解绑 → 存库 → 测试台）");
  const BGV = [0x20, 0x20, 0x20];
  const settle = () => new Promise((r) => setTimeout(r, 400));
  const ctl = (name) => `.ed-prop[data-prop="${name}"] .ed-fx-param [data-prop="${name}"]`;
  const upDeclare = async (name, type) => {
    await ev(`(() => {
      const n = document.querySelector('#up-name'); n.value = '${name}'; n.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#up-type').value = '${type}';
      document.querySelector('#up-add').click(); return true; })()`);
    await waitFor(`!!document.querySelector('.ed-prop[data-prop="${name}"]')`, 10000);
    await settle();
  };
  const upFire = (name, value, type) =>
    ev(`(() => { const el = document.querySelector('${ctl(name)}'); el.value = '${value}'; el.dispatchEvent(new Event('${type}', { bubbles: true })); return true; })()`);
  const deselect = async (cr) => {
    await click(worldToPage(cr, [300, 540]));
    await waitFor(`!!document.querySelector('.ed-props')`, 10000);
  };
  const bindSel = async (field, value) => {
    const r0 = await h.readyCount();
    await ev(`(() => { const s = document.querySelector('.ed-bindings select[data-bind="${field}"]'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await h.waitRemount(r0);
  };
  const mix = (a, k) => RED.map((c, i) => Math.round(c * k + BGV[i] * (1 - k)));

  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#202020");
  await addImage(stripePath);
  const crV = await h.canvasRect();
  const vTop = worldToPage(crV, [1110, 590]);
  check(await ev(`!!document.querySelector('.ed-bindings') && /用户属性|user properties/i.test(document.querySelector('.ed-bindings').textContent)`), "图层检视器有「属性绑定」分组，没有属性时提示先去场景级声明");
  await deselect(crV);
  check(await ev(`document.querySelector('#up-add').disabled && document.querySelectorAll('#up-type option').length === 5`), "不选图层：出现「用户属性」面板，五种类型，名字为空时「声明」不可点");
  await ev(`(() => { const n = document.querySelector('#up-name'); n.value = '1bad'; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  check(await ev(`document.querySelector('#up-add').disabled`), "非标识符名字：「声明」不可点");

  const rDecl = await h.readyCount();
  await upDeclare("op", "slider");
  check((await h.readyCount()) === rDecl && (await h.dirtyTitle()), "声明 slider「op」：热更不重挂，带脏标记");
  check(await ev(`document.querySelector('${ctl("op")}').value === '0.5' && document.querySelector('.ed-prop[data-prop="op"] .ed-prop-range').value === '0 1 0.01'`), "新属性默认 0.5、范围 0 1 0.01");

  await click(await h.rowCenter("stripe"));
  await waitFor(`!!document.querySelector('.ed-bindings select[data-bind="alpha"]')`, 10000);
  check((await ev(`[...document.querySelectorAll('.ed-bindings select')].map((s) => s.dataset.bind)`)).join() === "visible,alpha,brightness,scale,color", "图片层可绑字段：visible / alpha / brightness / scale / color");
  check((await ev(`[...document.querySelectorAll('.ed-bindings select[data-bind="alpha"] option')].map((o) => o.value)`)).join() === ",op" && (await ev(`[...document.querySelectorAll('.ed-bindings select[data-bind="color"] option')].length`)) === 1, "只列类型兼容的属性（alpha 可选 op，color 无可选）");
  await bindSel("alpha", "op");
  const vHalf = await pixelAt(vTop);
  check(close(vHalf, mix(RED, 0.5), 14), `★ alpha 绑 op(0.5)：图层半透明（期望 ≈${mix(RED, 0.5)}，实得 ${vHalf}）`);
  check(await ev(`document.querySelector('.ed-bindings select[data-bind="alpha"]').value === 'op'`), "重挂后绑定下拉显示 op");

  await deselect(crV);
  const rDrag = await h.readyCount();
  await upFire("op", "0", "input");
  await settle();
  const vPrev = await pixelAt(vTop);
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
  const rCombo = await h.readyCount();
  await upFire("mode", "1", "change");
  await settle();
  check((await h.readyCount()) === rCombo && isRed(await pixelAt(vTop)), "★ combo 切到 1：图层显示（热更，不重挂）");

  await upFire("op", "0.3", "change");
  await settle();
  const v03 = await pixelAt(vTop);
  check(close(v03, mix(RED, 0.3), 14), `op = 0.3：图层 30% 不透明（实得 ${v03}）`);
  const rDel = await h.readyCount();
  await ev(`(() => { document.querySelector('.ed-prop[data-prop="op"] .ed-prop-del').click(); return true; })()`);
  await h.waitRemount(rDel);
  check(!(await ev(`!!document.querySelector('.ed-prop[data-prop="op"]')`)) && isRed(await pixelAt(vTop)), "删除 op：alpha 解绑回快照 1，图层全不透明");
  await undoRedo(false);
  check(close(await pixelAt(vTop), mix(RED, 0.3), 14) && (await ev(`!!document.querySelector('.ed-prop[data-prop="op"]')`)), "撤销删除：属性与绑定一并回来");
  await undoRedo(true);
  const editorV = await pixelAt(vTop);
  check(isRed(editorV), "重做删除");

  const libBeforeV = new Set(fs.readdirSync(lib));
  const scV = await h.savedCount();
  await clickSel("#tb-save");
  await clickSel("#save-lib");
  await h.waitSaved(scV);
  const savedV = fs.readdirSync(lib).filter((n) => !libBeforeV.has(n));
  const sceneV = JSON.parse(fs.readFileSync(path.join(lib, savedV[0], "scene.json"), "utf8"));
  const projV = JSON.parse(fs.readFileSync(path.join(lib, savedV[0], "project.json"), "utf8"));
  const stripeV = sceneV.objects.find((o) => o.name === "stripe");
  check(JSON.stringify(stripeV?.visible?.user) === JSON.stringify({ name: "mode", condition: "1" }) && typeof stripeV.alpha !== "object", `盘上 scene.json：visible 条件绑定保留，alpha 已解绑（${JSON.stringify({ visible: stripeV?.visible, alpha: stripeV?.alpha })}）`);
  const propsV = projV.general?.properties ?? {};
  check(propsV.mode?.type === "combo" && propsV.mode.value === "1" && !("op" in propsV), `盘上 project.json：general.properties 有 mode=1、无 op（${JSON.stringify(propsV).slice(0, 90)}）`);
  const errsV = await h.errorLines();
  check(errsV.filter((l) => !/alpha' 失败/.test(l)).length === 0, `用户属性流程无错误${errsV.length ? `：${errsV.slice(0, 2).join(" / ")}` : ""}`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedV[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vpV = await ev(`({ w: innerWidth, h: innerHeight })`);
  const bV = await pixelAt(worldToPage({ x: 0, y: 0, w: vpV.w, h: vpV.h }, [1110, 590]));
  check(close(bV, editorV, 12), `测试台：按存盘属性值出帧，与编辑器一致（测试台 ${bV} / 编辑器 ${editorV}）`);

  // ════════════════════════════════════════════════════════════════════════
  section("W. 外来脚本拦截（W10 过渡：在线版默认不执行，逐文档放行）");
  const firstFrame = `${"/首帧就绪|First frame ready/"}.test(document.querySelector('#ed-con-body').textContent)`;
  const bannerOn = () => ev(`!document.querySelector('#ed-scripts-off').hidden`);
  // U 段存进库的条目：stripe 的 alpha 脚本 `return 0.5`
  await gotoEditor(`?scripts=off&item=${savedU[0]}`);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(firstFrame, 90000);
  await settle();
  const crW = await h.canvasRect();
  const wTop = worldToPage(crW, [1110, 590]);
  const blocked = await pixelAt(wTop);
  check(isRed(blocked), `?scripts=off 打开带脚本的库条目：脚本不执行，alpha 停在快照 1（实得 ${blocked}）`);
  check((await bannerOn()) && /1/.test(await ev(`document.querySelector('#ed-scripts-off-text').textContent`)), "视口底部提示「已拦截 1 段脚本」并给「仍然执行」");
  check((await ev(`document.querySelector('#ed-con-body').textContent`)).includes("scripts disabled: skipped 1"), "诊断流记一条拦截计数");
  const rAllow = await h.readyCount();
  await clickSel("#scripts-allow");
  await h.waitRemount(rAllow);
  await settle();
  const allowed = await pixelAt(wTop);
  check(close(allowed, half, 14) && !(await bannerOn()), `「仍然执行」：原地重挂，脚本生效（半透明 ${allowed}），提示收起`);

  await gotoEditor(`?item=${savedU[0]}`);
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
  const crW2 = await h.canvasRect();
  check(close(await pixelAt(worldToPage(crW2, [1110, 590])), BGV, 10) && !(await bannerOn()), "安全模式下新建的工程：用户自己写的脚本照常执行");

  // ════════════════════════════════════════════════════════════════════════
  section("X. 导出 WE 原生 scene.pkg（空白 → 图片层 + 效果 → 勾选原生格式存库 → 测试台 / 重新打开出帧一致）");
  const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
  const { parseTex, decodeMip0 } = await imp("renderer/vendor/we-scene/pkg/texture.js");
  await gotoEditor();
  await ev(`new Promise((ok) => { const r = indexedDB.deleteDatabase('webwallgl-editor'); r.onsuccess = r.onerror = r.onblocked = () => ok(true); })`);
  await gotoEditor();
  await newBlank("#000000");
  await addImage(stripePath);
  await fxAdd("tint");
  await settle();
  const crX = await h.canvasRect();
  const xTop = await pixelAt(worldToPage(crX, [1110, 590]));
  const xBot = await pixelAt(worldToPage(crX, [1110, 490]));
  check(close(xTop, tintWant, 6), `编辑器：红色图层叠上缺省橙色 50%（期望 ${tintWant}，实得 ${xTop}）`);

  const libBeforeX = new Set(fs.readdirSync(lib));
  const scX = await h.savedCount();
  await clickSel("#tb-save");
  check(await ev(`!document.querySelector('#save-menu').hidden && document.querySelector('#save-pkg').checked === false`), "保存菜单有「WE 原生格式」勾选，缺省不勾（默认仍是松散工程）");
  await clickSel("#save-pkg");
  check(await ev(`document.querySelector('#save-pkg').checked && !document.querySelector('#save-menu').hidden`), "勾选后菜单不收起");
  await clickSel("#save-lib");
  await h.waitSaved(scX);
  const savedX = fs.readdirSync(lib).filter((n) => !libBeforeX.has(n));
  check(savedX.length === 1, `另存到壁纸库：新条目 ${savedX[0]}`);
  const dirX = path.join(lib, savedX[0]);
  const filesX = fs.readdirSync(dirX).filter((n) => !n.startsWith(".")).sort();
  check(JSON.stringify(filesX) === JSON.stringify(["preview.jpg", "project.json", "scene.pkg"]), `盘上 = project.json + scene.pkg + 封面，无散装资源（${JSON.stringify(filesX)}）`);
  const projX = JSON.parse(fs.readFileSync(path.join(dirX, "project.json"), "utf8"));
  check(projX.file === "scene.json" && projX.type === "scene", "project.json：file 指包内 scene.json");
  const pkX = parsePkg(new Uint8Array(fs.readFileSync(path.join(dirX, "scene.pkg"))));
  const namesX = pkX.entries.map((e) => e.name);
  check(namesX.includes("scene.json") && namesX.includes("materials/editor/stripe.tex") && !namesX.some((n) => /\.(png|jpe?g)$/i.test(n)) && namesX.includes("shaders/effects/wwgl_tint.frag"), `包内：入口 + .tex 贴图 + 效果四件，无源图（${namesX.length} 项）`);
  const texX = decodeMip0(parseTex(getEntry(pkX, "materials/editor/stripe.tex")));
  check(texX.png && Buffer.compare(Buffer.from(texX.png), fs.readFileSync(stripePath)) === 0 && texX.width === 400 && texX.height === 200, ".tex 内嵌的就是拖进来的 PNG 原字节（400×200，零重编码）");
  check(/已打包 scene\.pkg|Packed scene\.pkg/.test(await ev(`document.querySelector('#ed-con-body').textContent`)), "控制台记一条打包摘要");
  const errsX = await h.errorLines();
  check(errsX.length === 0, `导出全程无错误${errsX.length ? `：${errsX.slice(0, 2).join(" / ")}` : ""}`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedX[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 1`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vpX = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchX = { x: 0, y: 0, w: vpX.w, h: vpX.h };
  const bTopX = await pixelAt(worldToPage(benchX, [1110, 590]));
  const bBotX = await pixelAt(worldToPage(benchX, [1110, 490]));
  check(close(bTopX, xTop, 12) && close(bBotX, xBot, 12), `★ 测试台按 scene.pkg 出帧，与编辑器一致（测试台 ${bTopX} / ${bBotX}，编辑器 ${xTop} / ${xBot}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/pkg-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/pkg-in-bench.jpg`);

  await gotoEditor(`?item=${savedX[0]}`);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 1`, 90000);
  await waitFor(firstFrame, 90000);
  await settle();
  check(close(await pixelAt(worldToPage(await h.canvasRect(), [1110, 590])), xTop, 12), "编辑器重新打开导出的包条目：画面一致");

  // ════════════════════════════════════════════════════════════════════════
  section("Y. 文字层端到端（空白 → 文字 / 时钟层 → 改内容 / 字号 / 颜色 / 导入字体 → 撤销 → 存库 → 测试台出帧一致）");
  /** 页面矩形内的墨水：亮像素占比 + 亮像素平均色（黑底） */
  const inkIn = async ([x0, y0], [x1, y1], thr = 200) => {
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
  const worldBox = (cr, [cx, cy], [hw, hh]) => [worldToPage(cr, [cx - hw, cy + hh]), worldToPage(cr, [cx + hw, cy - hh])];
  const rawObj = () => ev(`JSON.parse(document.querySelector('.ed-insp-raw').textContent)`);
  const textAct = (js) => fxAct(js);
  const setText = (name, value) =>
    textAct(`const el = document.querySelector('.ed-text [data-text="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  const addTextPreset = async (preset) => {
    const r0 = await h.readyCount();
    await clickSel("#ly-add-text");
    await clickSel(`#text-menu button[data-preset="${preset}"]`);
    await h.waitRemount(r0);
  };
  /** 页面里按引擎同一字体栈量宽度（Arial 系统字体） */
  const arialWidth = (s, px) => ev(`(() => { const c = document.createElement('canvas').getContext('2d'); c.font = '${px}px Arial, \\'Helvetica Neue\\', sans-serif, sans-serif'; return c.measureText(${JSON.stringify(s)}).width; })()`);
  const sizeOf = (o) => String(o.size).split(/\s+/).map(Number);

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
  const plainName = (await h.treeNames())[0];
  check((await h.treeNames()).length === 1 && (await h.selectedName()) === plainName && /文字|Text/.test(plainName), `添加文字层：树里一层「${plainName}」并选中`);
  check(await ev(`!!document.querySelector('.ed-text') && !document.querySelector('.ed-text [data-text="content"]').readOnly`), "检视器有「文字」分组，内容可编辑");
  check(await ev(`document.querySelector('.ed-text [data-text="font"]').value === 'systemfont_arial' && document.querySelector('.ed-text [data-text="size"]').value === '32'`), "缺省字体 Arial、字号 32");

  await setText("content", "MMM");
  let o = await rawObj();
  const wantW = await arialWidth("MMM", 128);
  check(o.text === "MMM" && Math.abs(sizeOf(o)[0] - wantW) < 0.01 && Math.abs(sizeOf(o)[1] - 153.6) < 0.01, `改内容后盒按页面实测宽度回填（size ${o.size}，Arial 实测 ${wantW.toFixed(3)}）`);
  await setText("size", "60");
  o = await rawObj();
  check(o.pointsize === 60 && Math.abs(sizeOf(o)[1] - 288) < 0.01 && Math.abs(sizeOf(o)[0] - (await arialWidth("MMM", 240))) < 0.01, `改字号 60：盒跟着重量（${o.size}）`);
  await h.setInputs({ 0: 960, 1: 800 });
  await settle();
  const crY = await h.canvasRect();
  const boxW = sizeOf(o)[0] / 2;
  let ink = await inkIn(...worldBox(crY, [960, 800], [boxW, 110]));
  check(ink.frac > 0.12 && ink.color.every((c) => c > 200), `画面真画出白色文字（墨水占比 ${ink.frac.toFixed(3)}，色 ${ink.color}）`);
  check((await inkIn(...worldBox(crY, [960, 540], [boxW, 110]))).frac < 0.01, "挪到 y=800 后原位置没有残影");

  await ev(`(() => { const c = document.querySelector('#ed-inspector fieldset.ed-form input[type=color]'); c.focus(); c.value = '#ff0000'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); c.blur(); return true; })()`);
  await settle();
  ink = await inkIn(...worldBox(crY, [960, 800], [boxW, 110]));
  check(ink.frac > 0.12 && ink.color[0] > 200 && ink.color[1] < 60 && ink.color[2] < 60, `颜色改红：文字变红（${ink.color}）`);

  await setText("halign", "right");
  o = await rawObj();
  check(o.horizontalalign === "right" && (await ev(`document.querySelector('.ed-text [data-text="halign"]').value`)) === "right", "水平对齐改右：文档与控件一致");
  await setText("halign", "center");

  const fontPath = "/System/Library/Fonts/Supplemental/Arial Black.ttf";
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
  const names = await h.treeNames();
  check(names.length === 2 && /时钟|Clock/.test(names[1]) && (await h.selectedName()) === names[1], `添加时钟层：第二层「${names[1]}」并选中`);
  check(await ev(`document.querySelector('.ed-text [data-text="content"]').readOnly && !!document.querySelector('.ed-script[data-target="text"]')`), "时钟内容只读，脚本分组里有 text 脚本");
  await settle();
  const clockInk = await inkIn(...worldBox(crY, [960, 540], [300, 70]));
  check(clockInk.frac > 0.05, `时钟在画面中心画出时间（墨水占比 ${clockInk.frac.toFixed(3)}）`);
  check(await ev(`(() => { const L = document.querySelector('#ed-con-body').textContent; return !/脚本.*错误|script.*error/i.test(L); })()`), "时钟脚本运行无错误");

  let r1 = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(r1);
  check((await h.treeNames()).length === 1, "撤销添加时钟：回到一层");
  r1 = await h.readyCount();
  await key("z", MOD.meta | MOD.shift);
  await h.waitRemount(r1);
  check((await h.treeNames()).length === 2, "重做：时钟回来");

  const libBeforeY = new Set(fs.readdirSync(lib));
  const scY = await h.savedCount();
  await clickSel("#tb-save");
  if (await ev(`document.querySelector('#save-pkg').checked`)) await clickSel("#save-pkg");
  await clickSel("#save-lib");
  await h.waitSaved(scY);
  const savedY = fs.readdirSync(lib).filter((n) => !libBeforeY.has(n));
  check(savedY.length === 1, `另存到壁纸库：新条目 ${savedY[0]}`);
  const dirY = path.join(lib, savedY[0]);
  const sceneY = JSON.parse(fs.readFileSync(path.join(dirY, "scene.json"), "utf8"));
  const [tPlain, tClock] = sceneY.objects;
  const plainColor = String(tPlain.color).trim().split(/\s+/).map(Number);
  check(sceneY.objects.length === 2 && tPlain.text === "MMM" && tPlain.pointsize === 60 && close(plainColor, [1, 0, 0], 1e-3), `盘上 scene.json：文字层内容 / 字号 / 颜色（${JSON.stringify({ text: tPlain.text, pointsize: tPlain.pointsize, color: tPlain.color })}）`);
  check(typeof tClock.text === "object" && /getHours/.test(tClock.text.script) && tClock.text.scriptproperties?.use24h === true, "盘上时钟层：{ script, scriptproperties, value } 原样");
  if (fs.existsSync(fontPath)) {
    check(fs.existsSync(path.join(dirY, "fonts/arial-black.ttf")) && Buffer.compare(fs.readFileSync(path.join(dirY, "fonts/arial-black.ttf")), fs.readFileSync(fontPath)) === 0, "盘上字体文件逐字节原样");
  }
  const errsY = await h.errorLines();
  check(errsY.length === 0, `文字层编辑全程无错误${errsY.length ? `：${errsY.slice(0, 2).join(" / ")}` : ""}`);

  await gotoEditor(`?item=${savedY[0]}`);
  await waitFor(`document.querySelectorAll('#ed-tree .ed-node').length === 2`, 90000);
  await waitFor(firstFrame, 90000);
  await new Promise((r) => setTimeout(r, 800));
  const crY2 = await h.canvasRect();
  const edPlain = await inkIn(...worldBox(crY2, [960, 800], [boxW * 1.4, 110]));
  check(edPlain.frac > 0.12 && edPlain.color[0] > 200 && edPlain.color[1] < 60, `编辑器重新打开：红字在原位（${edPlain.frac.toFixed(3)} / ${edPlain.color}）`);

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedY[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vpY = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchY = { x: 0, y: 0, w: vpY.w, h: vpY.h };
  const bPlain = await inkIn(...worldBox(benchY, [960, 800], [boxW * 1.4, 110]));
  const bClock = await inkIn(...worldBox(benchY, [960, 540], [300, 70]));
  check(Math.abs(bPlain.frac - edPlain.frac) < 0.04 && close(bPlain.color, edPlain.color, 25), `★ 测试台文字出帧与编辑器一致（墨水 ${bPlain.frac.toFixed(3)} vs ${edPlain.frac.toFixed(3)}，色 ${bPlain.color} vs ${edPlain.color}）`);
  check(bClock.frac > 0.05, `★ 测试台时钟层画出时间（墨水占比 ${bClock.frac.toFixed(3)}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/text-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/text-in-bench.jpg`);

  // ════════════════════════════════════════════════════════════════════════
  section("Z. 粒子层端到端（空白 → 雪 → 调数量 / 颜色 → 撤销 → 火花 → 存库 → 测试台出帧）");
  const ptSet = (name, value) =>
    fxAct(`const el = document.querySelector('.ed-particle [data-particle="${name}"]'); el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  const ptCheck = (name, on) =>
    fxAct(`const el = document.querySelector('.ed-particle [data-particle="${name}"]'); el.checked = ${on}; el.dispatchEvent(new Event('change', { bubbles: true }))`);
  const addParticlePreset = async (preset) => {
    const r0 = await h.readyCount();
    await clickSel("#ly-add-particle");
    await clickSel(`#particle-menu button[data-preset="${preset}"]`);
    await h.waitRemount(r0);
  };
  /** 整个画面的墨水（粒子随机，取全屏统计；halo 边缘很软，门槛放低） */
  const fullInk = async (cr) => {
    await new Promise((r) => setTimeout(r, 900));
    return inkIn(...worldBox(cr, [960, 540], [956, 536]), 60);
  };
  const whitish = (c) => Math.min(...c) > 40 && Math.max(...c) - Math.min(...c) < 25;
  const reddish = (c) => c[0] > 80 && c[0] > 2 * c[1] && c[0] > 2 * c[2];

  await gotoEditor();
  check(await ev(`document.querySelector('#ly-add-particle').disabled`), "未打开场景时「添加粒子层」不可用");
  await newBlank("#000000");
  check(!(await ev(`document.querySelector('#ly-add-particle').disabled`)), "新建后「添加粒子层」可用");
  await clickSel("#ly-add-particle");
  check(await ev(`!document.querySelector('#particle-menu').hidden && document.querySelectorAll('#particle-menu button[data-preset]').length === 4`), "点开粒子菜单：雪 / 雨 / 火花 / 光点四项");
  await clickSel("#ly-add-text");
  check(await ev(`document.querySelector('#particle-menu').hidden && !document.querySelector('#text-menu').hidden`), "点文字按钮：粒子菜单收起、文字菜单打开（同时只开一个）");
  await clickSel("#ly-add-text");

  await addParticlePreset("snow");
  const snowName = (await h.treeNames())[0];
  check((await h.treeNames()).length === 1 && (await h.selectedName()) === snowName && /雪|Snow/.test(snowName), `添加雪：树里一层「${snowName}」并选中`);
  check(await ev(`document.querySelectorAll('.ed-particle input[type=range][data-particle]').length === 6 && !!document.querySelector('.ed-particle [data-particle="color"]')`), "检视器有「粒子」分组：6 个倍率滑条 + 颜色");
  check(await ev(`!document.querySelector('.ed-particle [data-particle="colorOn"]').checked && document.querySelector('.ed-particle [data-particle="color"]').disabled`), "缺省不覆盖颜色（颜色框灰掉）");
  let po = await rawObj();
  check(po.particle === "particles/editor/snow.json" && po.instanceoverride?.count === 1, "文档：particle 指向 particles/editor/snow.json，倍率初始 1");
  const crZ = await h.canvasRect();
  const snowInk = await fullInk(crZ);
  check(snowInk.frac > 0.002 && whitish(snowInk.color), `画面真画出白色雪花（墨水占比 ${snowInk.frac.toFixed(4)}，色 ${snowInk.color}）`);

  await ptSet("count", "0");
  po = await rawObj();
  const noneInk = await fullInk(crZ);
  check(po.instanceoverride.count === 0 && noneInk.frac < snowInk.frac * 0.2, `数量拖到 0：instanceoverride.count = 0，画面几乎没有雪（${noneInk.frac.toFixed(4)}）`);
  let rz = await h.readyCount();
  await key("z", MOD.meta);
  await h.waitRemount(rz);
  po = await rawObj();
  const backInk = await fullInk(crZ);
  check(po.instanceoverride.count === 1 && backInk.frac > snowInk.frac * 0.5, `撤销：数量回到 1，雪回来（${backInk.frac.toFixed(4)}）`);

  await ptSet("size", "3");
  await ptCheck("colorOn", true);
  await ptSet("color", "#ff0000");
  po = await rawObj();
  check(po.instanceoverride.size === 3 && po.instanceoverride.colorn === "1.000 0.000 0.000", `大小 3 + 颜色覆盖红：instanceoverride ${JSON.stringify(po.instanceoverride)}`);
  check(await ev(`document.querySelector('.ed-particle [data-particle="colorOn"]').checked && document.querySelector('.ed-particle [data-particle="color"]').value === '#ff0000'`), "检视器重绘后控件与文档一致");
  const redInk = await fullInk(crZ);
  check(redInk.frac > snowInk.frac * 1.5 && reddish(redInk.color), `画面：雪花变大变红（墨水 ${redInk.frac.toFixed(4)}，色 ${redInk.color}）`);

  await addParticlePreset("embers");
  const namesZ = await h.treeNames();
  check(namesZ.length === 2 && /火花|Embers/.test(namesZ[1]), `添加火花：第二层「${namesZ[1]}」`);
  const errsZ = await h.errorLines();
  check(errsZ.length === 0, `粒子层编辑全程无错误${errsZ.length ? `：${errsZ.slice(0, 2).join(" / ")}` : ""}`);

  const libBeforeZ = new Set(fs.readdirSync(lib));
  const scZ = await h.savedCount();
  await clickSel("#tb-save");
  if (await ev(`document.querySelector('#save-pkg').checked`)) await clickSel("#save-pkg");
  await clickSel("#save-lib");
  await h.waitSaved(scZ);
  const savedZ = fs.readdirSync(lib).filter((n) => !libBeforeZ.has(n));
  check(savedZ.length === 1, `另存到壁纸库：新条目 ${savedZ[0]}`);
  const dirZ = path.join(lib, savedZ[0]);
  const sceneZ = JSON.parse(fs.readFileSync(path.join(dirZ, "scene.json"), "utf8"));
  const [zSnow, zEmbers] = sceneZ.objects;
  check(sceneZ.objects.length === 2 && zSnow.instanceoverride?.colorn === "1.000 0.000 0.000" && zSnow.instanceoverride?.size === 3 && zEmbers.particle === "particles/editor/embers.json", "盘上 scene.json：雪的调参与火花层");
  const onDisk = ["particles/editor/snow.json", "materials/editor/particles/snow.json", "particles/editor/embers.json", "materials/editor/particles/embers.json"];
  check(onDisk.every((f) => fs.existsSync(path.join(dirZ, f))), "盘上两层各自的粒子 / 材质文件都在");
  check(JSON.parse(fs.readFileSync(path.join(dirZ, "materials/editor/particles/embers.json"), "utf8")).passes[0].textures[0] === "particle/halo" && !fs.existsSync(path.join(dirZ, "materials/particle")), "材质只引用内置名，没有拷贝贴图文件");

  await cdp.send("Page.navigate", {
    url: `${origin}/renderer/index.html?type=scene&src=${savedZ[0]}&mediaBase=${origin}/media/dev&fit=cover&renderDpr=1&muted=true&loop=true`,
  });
  await waitFor(`window.__wp && window.__sceneLayers && window.__sceneLayers.length === 2`, 90000);
  await new Promise((r) => setTimeout(r, 1500));
  const vpZ = await ev(`({ w: innerWidth, h: innerHeight })`);
  const benchZ = await inkIn(...worldBox({ x: 0, y: 0, w: vpZ.w, h: vpZ.h }, [960, 540], [956, 536]), 60);
  const top = await inkIn(...worldBox({ x: 0, y: 0, w: vpZ.w, h: vpZ.h }, [960, 800], [956, 270]), 60);
  check(benchZ.frac > snowInk.frac && top.color[0] > 80 && top.color[0] > top.color[2] + 30, `★ 测试台出帧：红色大雪花 + 火花（墨水 ${benchZ.frac.toFixed(4)}，上半屏色 ${top.color}）`);
  await ctx.session.screenshot({ out: path.join(ROOT, "scripts/.tmp-editor-e2e/particles-in-bench.jpg") });
  console.log(`  截图：scripts/.tmp-editor-e2e/particles-in-bench.jpg`);
}
