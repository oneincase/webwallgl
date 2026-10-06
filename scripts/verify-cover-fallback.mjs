#!/usr/bin/env node
/**
 * verify-cover-fallback —— 图层自身材质的封面保留名（`$mediaThumbnail` / `$mediaPreviousThumbnail`）
 * 在封面「没来 / 晚来 / 早就在」三种时序下的槽 0 贴图（真 GPU，自起 vite）。
 *
 * 2026-10-07 缺陷：材质 `textures[0]` = 作者内置封面、`usertextures[0]` = 保留名时，封面未到
 * 只登记迟到绑定，而默认贴图回写把「登记了」当成「已占用」→ 层永远没有 textureName：
 * 普通封面层空着，puppet 层被判「无贴图」整层跳过（3465215190 的「画」）。
 *
 * 判据（逐层读 `__scene.layers[i].textureName`）：
 *   A. media:null（媒体禁用，封面永不到）→ 槽 0 = 作者内置贴图；puppet 层装上了骨骼网格
 *   B. 默认挂载（模拟源 tracks 为空，没有封面）→ 先是作者贴图；之后 setMedia 给一张封面 →
 *      `$mediaThumbnail` 的层切过去（迟到绑定顶替占位）
 *   C. 宿主挂载时就带封面（media: createMediaSource({thumbnail})）→ 封面上传后层切到保留名
 * 库形态下 `$mediaThumbnail` 总是装配后才异步上传（模拟源 tracks 恒空），「装配前封面已在」
 * 走不到；「封面先于作者贴图回调到达」的竞态由 reservedBound 守卫兜，verify-media 5d 锁源码。
 *
 * 用法：node scripts/verify-cover-fallback.mjs
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ROOT, LIB, imp } from "./lib/verify-kit.mjs";

/** 普通封面层（多种组件形态）+ $mediaPreviousThumbnail + puppet 封面层 */
const FIXTURES = (process.env.WE_COVER_ITEMS || "3151551777,3078285611,3629379075,2938612768,3012694124,2902406982,3465215190").split(",");

const C = await imp("renderer/vendor/we-scene/pkg/container.js");
const dec = new TextDecoder();
const readJson = (b) => {
  try {
    return b ? JSON.parse(dec.decode(b).replace(/^\uFEFF/, "")) : null;
  } catch {
    return null;
  }
};

/** 材质槽 0 是保留名、且作者内置贴图在包里的对象 */
function coverLayers(id) {
  const pkg = C.parsePkg(new Uint8Array(fs.readFileSync(path.join(LIB, id, "scene.pkg"))));
  const read = (n) => C.getEntry(pkg, n);
  const out = [];
  const objs = readJson(read("scene.json"))?.objects || [];
  const chainOf = (o) => {
    const ids = [];
    for (let cur = o; cur && !ids.includes(cur.id); cur = objs.find((x) => x.id === cur.parent)) ids.push(cur.id);
    return ids;
  };
  for (const o of objs) {
    if (typeof o.image !== "string" || o.instance) continue;
    const m = readJson(read(o.image));
    if (!m || typeof m.material !== "string") continue;
    const pass = readJson(read(m.material))?.passes?.[0];
    const u = pass?.usertextures?.[0];
    const reserved = typeof u === "string" ? u : u?.name;
    const t0 = pass?.textures?.[0];
    if (typeof reserved !== "string" || !reserved.startsWith("$") || typeof t0 !== "string" || t0.startsWith("util/")) continue;
    if (!read(`materials/${t0}.tex`)) continue;
    out.push({ id: o.id, name: o.name ?? "", reserved, t0, puppet: typeof m.puppet === "string" && !!m.puppet, chain: chainOf(o) });
  }
  return out;
}

let failed = 0;
const check = (ok, msg) => {
  if (!ok) failed++;
  (ok ? console.log : console.error)(`  ${ok ? "✓" : "✗"} ${msg}`);
};

const fixtures = FIXTURES.filter((id) => fs.existsSync(path.join(LIB, id, "scene.pkg")));
check(fixtures.length >= 4, `夹具壁纸至少 4 张在本机（${fixtures.join(", ")}）`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-cover-fallback-"));
const lib = path.join(tmp, "lib");
for (const id of fixtures) {
  fs.mkdirSync(path.join(lib, id), { recursive: true });
  for (const f of ["project.json", "scene.pkg"]) fs.copyFileSync(path.join(LIB, id, f), path.join(lib, id, f));
}
process.env.WE_LIBRARY = lib;
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
const origin = `http://127.0.0.1:${port}`;
const { launchHeadless, instrument } = await imp("scripts/headless-gpu.mjs");
const session = await launchHeadless({ url: "about:blank", task: "verify-cover-fallback", width: 1280, height: 720 });
instrument(session, { width: 1280, height: 720 });

const probe = async (id, layers, mode) => {
  await session.pageCdp.send("Page.navigate", { url: `${origin}/renderer/index.html?type=canvas` });
  await session.waitFor("!!window.__wp", { timeoutMs: 60000 });
  return session.evaluate(`(async () => {
    window.__wp.pause();
    const api = await import('/renderer/src/api/editor.ts');
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:960px;height:540px;z-index:9';
    document.body.appendChild(host);
    const ids = ${JSON.stringify(layers.map((l) => l.id))};
    const mode = ${JSON.stringify(mode)};
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = '#e02020';
    g.fillRect(0, 0, 64, 64);
    const cover = () => api.createMediaSource({ title: 'cover', playing: true, thumbnail: c.toDataURL('image/png') });
    const opts = { source: api.httpSource('${origin}/media/dev/${id}'), fit: 'cover', renderDpr: 1, volume: 0, autoplay: true };
    if (mode === 'none') opts.media = null;
    if (mode === 'host') opts.media = cover();
    const inst = await api.mount(host, opts);
    const read = () => ids.map((lid) => {
      const L = window.__scene.layers.find((l) => l.id === lid);
      return L ? { id: lid, tex: L.textureName ?? null, puppet: !!L.puppet } : { id: lid, missing: true };
    });
    const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    const waitCover = async () => {
      const t0 = performance.now();
      while (!(window.__textures.get('$mediaThumbnail') && !window.__textures.get('$mediaThumbnail').generated) && performance.now() - t0 < 8000) await frames(2);
      await frames(4);
      return !!window.__textures.get('$mediaThumbnail');
    };
    await frames(3);
    const out = { first: read(), had: window.__textures.has('$mediaThumbnail') };
    // puppet 封面层：只留它和父链，固定时刻出帧数红像素（封面是纯红），证明画面真的换了贴图
    const puppetKeep = ${JSON.stringify(layers.find((l) => l.puppet && l.reserved === "$mediaThumbnail")?.chain ?? null)};
    const ed = api.editorOf(inst);
    const redCount = async () => {
      const cv = await ed.captureFrame({ time: 1, width: 480, height: 270 });
      const d = cv.getContext('2d', { willReadFrequently: true })?.getImageData(0, 0, cv.width, cv.height).data
        ?? (() => { const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height; const g2 = t.getContext('2d'); g2.drawImage(cv, 0, 0); return g2.getImageData(0, 0, t.width, t.height).data; })();
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 80 && d[i + 2] < 80 && d[i + 3] > 128) n++;
      return n;
    };
    if (mode === 'late' && puppetKeep) {
      inst.pause();
      for (const l of ed.getLayers()) if (!puppetKeep.includes(l.id)) await ed.setLayerProps(l.id, { visible: false });
      // 关掉目标层效果链：有效果时画面走按 textureName 取图的合成结果（overrideTex），
      // 测不到网格直接绘制那一路是否跟随 textureName
      for (const e of window.__scene.layers.find((l) => l.id === puppetKeep[0])?.effects || []) e.visible = false;
      out.redBefore = await redCount();
    }
    if (mode === 'late') {
      inst.setMedia(cover());
      if (puppetKeep) inst.resume();
      out.arrived = await waitCover();
      out.after = read();
      if (puppetKeep) {
        inst.pause();
        out.redAfter = await redCount();
      }
    }
    if (mode === 'host') {
      out.arrived = await waitCover();
      out.after = read();
    }
    inst.destroy();
    return out;
  })()`, { awaitPromise: true, timeoutMs: 180000 });
};

try {
  console.log("\n封面保留名的槽 0 贴图：没来 / 晚来 / 早就在");
  let total = 0;
  for (const id of fixtures) {
    const layers = coverLayers(id);
    total += layers.length;
    if (!layers.length) {
      check(false, `${id}: 没找到封面层（夹具前提）`);
      continue;
    }
    const tag = layers.map((l) => `#${l.id}${l.puppet ? "(puppet)" : ""}`).join(",");
    const by = (arr, lid) => (arr || []).find((x) => x.id === lid) || {};
    const show = (bad, arr) => (bad.length ? ` —— ${JSON.stringify(bad.map((l) => [l.id, by(arr, l.id)]))}` : "");
    const placeholderOk = (arr) => layers.filter((l) => by(arr, l.id).tex !== l.t0 || (l.puppet && !by(arr, l.id).puppet));
    const none = await probe(id, layers, "none");
    const badA = placeholderOk(none.first);
    check(!none.had && badA.length === 0, `${id} A 媒体禁用：${tag} 槽 0 = 作者内置贴图${layers.some((l) => l.puppet) ? "，puppet 装上" : ""}` + show(badA, none.first));
    const cur = layers.filter((l) => l.reserved === "$mediaThumbnail");
    const late = await probe(id, layers, "late");
    const badB0 = placeholderOk(late.first);
    const badB = cur.filter((l) => by(late.after, l.id).tex !== "$mediaThumbnail");
    check(
      !late.had && badB0.length === 0 && late.arrived && badB.length === 0,
      `${id} B 默认挂载先显示作者贴图，封面晚到后 ${cur.length} 层切到 $mediaThumbnail` + (late.arrived ? "" : " —— 封面纹理没到") + show(badB0, late.first) + show(badB, late.after),
    );
    if (late.redBefore !== undefined) {
      check(late.redAfter > 500 && late.redAfter > late.redBefore * 4 + 200, `${id} B 像素：隔离出帧的 puppet 封面层红像素 ${late.redBefore} → ${late.redAfter}（画面真的换成了封面）`);
    }
    if (cur.length) {
      const hostR = await probe(id, layers, "host");
      const badC = cur.filter((l) => by(hostR.after, l.id).tex !== "$mediaThumbnail");
      check(hostR.arrived && badC.length === 0, `${id} C 宿主挂载即带封面：${cur.length} 层绑上 $mediaThumbnail` + (hostR.arrived ? "" : " —— 封面纹理没到") + show(badC, hostR.after));
    }
  }
  check(total >= 8, `覆盖 ${total} 个封面层`);
} finally {
  await session.close();
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n✗ ${failed} 处问题` : "\n✓ 全部通过");
process.exit(failed ? 1 : 0);
