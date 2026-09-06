#!/usr/bin/env node
/**
 * verify-arch —— 把 docs/ARCHITECTURE.md 里的边界规则变成会失败的断言。
 *
 * 查的都是**结构事实**（import 语句、模块能否被 Node 加载、契约文件存在），
 * 不是拿源码文本猜行为，也不是「改断言迁就现状」那类脆弱守卫。
 *
 * 覆盖：
 *   1. 分层依赖：引擎（renderer/vendor/we-scene）不得 import renderer/src、host、bench；
 *      host/ 不得 import 引擎与 renderer/src（宿主模拟只复刻端点，不消费引擎）。
 *   2. 引擎内相对 import 必须带显式 .js —— 这是 Node 侧离线校验能直接加载的前提。
 *   3. 引擎全部 .js 模块都能在 Node 里动态 import 成功 —— 这是 9+ 个离线 verifier
 *      存在的根基（DOM 依赖只允许藏在函数体内，不允许出现在模块顶层求值路径上）。
 *   4. 契约面存在：renderer/index.html 引用 /renderer/src/main.ts；
 *      window.__wp 的十个控制方法在 main.ts 里全部有定义（见 docs/INTEGRATION.md）。
 *
 * 退出码非 0 表示边界被破坏。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..");
const VENDOR = path.join(ROOT, "renderer/vendor/we-scene");

const errors = [];
const check = (cond, msg) => {
  if (!cond) errors.push(msg);
};

const listFiles = (dir, ext) => {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
};

// ---------- 1 & 2. import 边界与显式 .js ----------
const jsFiles = listFiles(VENDOR, ".js");
for (const f of jsFiles) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(VENDOR, f);
  const re = /(?:^|[^\w$])import\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]|export\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2];
    if (!spec || !spec.startsWith(".")) continue; // 引擎当前零外部依赖，裸包名即违约
    check(
      spec.endsWith(".js"),
      `${rel}：相对 import 必须带显式 .js（Node 直载前提）—— "${spec}"`,
    );
    const resolved = path.resolve(path.dirname(f), spec);
    check(
      resolved.startsWith(VENDOR),
      `${rel}：引擎不得 import 引擎外模块 —— "${spec}"`,
    );
  }
}

// host/ 不得 import 引擎与 renderer/src（bench 允许：测试台是引擎的只读消费方）
for (const f of listFiles(path.join(ROOT, "host"), ".ts")) {
  const src = fs.readFileSync(f, "utf8");
  const bad = /from\s+['"][^'"]*renderer\/(vendor|src)/.exec(src);
  check(!bad, `host/${path.basename(f)}：宿主模拟不得 import 引擎或渲染器源码`);
}

// ---------- 3. 全部引擎模块 Node 可加载 ----------
for (const f of jsFiles) {
  const rel = path.relative(ROOT, f);
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    check(false, `${rel}：Node 动态 import 失败 —— ${String(e && e.message).slice(0, 120)}`);
  }
}

// ---------- 4. 契约面 ----------
const entryHtml = path.join(ROOT, "renderer/index.html");
check(fs.existsSync(entryHtml), "契约面：renderer/index.html 必须存在（主项目 rollup 入口）");
if (fs.existsSync(entryHtml)) {
  const html = fs.readFileSync(entryHtml, "utf8");
  check(html.includes("/renderer/src/main.ts"), "契约面：renderer/index.html 必须引用 /renderer/src/main.ts");
}

const mainTs = fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8");
// window.__wp = { setWallpaper(cfg) {...}, ... } —— 对象字面量方法简写，
// 取赋值开始到配对右花括号之间的块，收集 2 层缩进的方法名。
const wpStart = mainTs.indexOf("window.__wp = {");
check(wpStart >= 0, "契约面：main.ts 缺少 window.__wp 赋值");
const defined = new Set();
if (wpStart >= 0) {
  let depth = 0;
  let end = -1;
  for (let i = wpStart + "window.__wp = ".length; i < mainTs.length; i++) {
    if (mainTs[i] === "{") depth++;
    else if (mainTs[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  check(end > 0, "契约面：window.__wp 赋值块无法解析（括号配对失败）");
  if (end > 0) {
    const block = mainTs.slice(wpStart, end);
    const mRe = /^  (\w+)\s*\(/gm;
    let m;
    while ((m = mRe.exec(block))) defined.add(m[1]);
  }
}
const REQUIRED_WP = [
  "setWallpaper",
  "pause",
  "resume",
  "setFit",
  "setVolume",
  "release",
  "restore",
  "setRenderDpr",
  "setSceneFps",
  "updateWebProps",
  // 外部指针注入（桌面 underlay 层收不到鼠标事件，宿主轮询系统鼠标后推入）。
  // 下游 WallpaperEM 按 docs/INTEGRATION.md 对接；改名或删除会静默断掉桌面交互，
  // 且没有任何报错 —— 壁纸只是永远不响应鼠标，所以纳入契约面守卫。
  "pushPointer",
  "pointerLeave",
];
for (const name of REQUIRED_WP) {
  check(defined.has(name), `契约面：window.__wp.${name} 在 main.ts 里缺失（见 docs/INTEGRATION.md）`);
}

// README 约定 GET scene.pkg 再回退 scenes/scene.pkg。WKWebView 对缺失路径抛
// Failed to fetch，若源码仍先打 scenes/，本机 178 张根目录 pkg 会整场失败。
// 2026-09-03 库化改造：这段逻辑从 scene-mount 搬到 api/source.ts 的 httpSource
// （docs/LIBRARY-PLAN.md §7.4），守卫随逻辑搬家，判据本身不改弱。
{
  const source = fs.readFileSync(path.join(ROOT, "renderer/src/api/source.ts"), "utf8");
  const rootIdx = source.indexOf('"scene.pkg"');
  const nestedIdx = source.indexOf('"scenes/scene.pkg"');
  check(rootIdx >= 0 && nestedIdx > rootIdx, "httpSource 必须先拉根目录 scene.pkg，再试 scenes/scene.pkg");
  check(/catch\s*\([^)]*\)\s*\{[\s\S]{0,160}lastThrow/.test(source), "httpSource 每次 fetch scene.pkg 必须单独 catch（否则 WKWebView 一抛就没回退）");
  check(
    source.includes("读取 scene.pkg 体失败"),
    "httpSource 必须单独接住 arrayBuffer 失败（HTTP 200 后 Failed to fetch 是 body 被掐，不是缺路径）",
  );
}

// 超宽场景（3264246690 的 5120×1440）靠 cover 按窗口宽高比裁切。画布 backing
// store 若只在挂载时量一次，窗口改比例后相机仍按旧宽高比算，CSS 再把旧
// framebuffer 拉伸 → 看起来像没适配。渲染循环必须每帧 syncCanvasSize。
{
  const shell = fs.readFileSync(path.join(ROOT, "renderer/src/shell.ts"), "utf8");
  const mount = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const media = fs.readFileSync(path.join(ROOT, "renderer/src/media.ts"), "utf8");
  check(/export function syncCanvasSize/.test(shell), "shell.ts 必须导出 syncCanvasSize（画布 backing store 对齐窗口）");
  // 2026-09-03 库化第 2 步：state 单例 → Runtime 实例（rt 首参），守卫模式随之更新
  check(
    /^[ \t]*syncCanvasSize\s*\(\s*rt\s*,\s*c\s*,\s*rt\.cfg\s*\)/m.test(mount),
    "scene-mount 渲染循环必须每帧 syncCanvasSize（窗口改比例后 cover 才跟着裁，否则 CSS 把旧 framebuffer 拉伸）",
  );
  check(
    /^[ \t]*syncCanvasSize\s*\(\s*rt\s*,\s*c\s*,\s*rt\.cfg\s*\)/m.test(media),
    "media.ts 渲染循环必须每帧 syncCanvasSize（媒体壁纸与场景同一条 cover 路径）",
  );
}

// Vite async middleware 在 Promise resolve 时若 body 还在传，html-fallback
// 会掐掉大 scene.pkg。必须等可读流结束，禁止 createReadStream().pipe(res) 立刻返回。
{
  const host = fs.readFileSync(path.join(ROOT, "host/wallpaper-host.ts"), "utf8");
  check(/function pipeFile/.test(host), "wallpaper-host 必须以 pipeFile 等流结束后再结束 middleware");
  check(
    !/createReadStream\([^)]*\)\.pipe\(\s*res\s*\)/.test(host),
    "wallpaper-host 不得 createReadStream().pipe(res) 后立刻返回（8MB+ scene.pkg 会被 Vite 掐掉）",
  );
}

// 互动声音/视频：startsilent 不得一律 play；getVideoTexture 不得恒 null。
// 2887099508 一加载就 video play fail AbortError、点耳朵没声音，就是这两处 stub。
{
  const mount = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const textSrc = fs.readFileSync(path.join(VENDOR, "render/text.js"), "utf8");
  check(
    /soundprops\?\.startsilent/.test(mount),
    "scene-mount 声音层必须按 startsilent 决定是否自动 play",
  );
  check(
    /soundCtl/.test(mount) && /videoCtl/.test(mount) && /soundCtl/.test(textSrc) && /getVideoTexture/.test(textSrc),
    "声音/视频控制必须接到图层 soundCtl/videoCtl（脚本 thisLayer.play / getVideoTexture）",
  );
  check(
    !/getVideoTexture:\s*\(\)\s*=>\s*null/.test(textSrc),
    "getVideoTexture 不得恒返回 null（语料 init 里 video.stop() 不判空）",
  );
}

// pause/resume/改自定义配置不得整包重挂；大 pkg 不得每入口再拷一份。
{
  const main = fs.readFileSync(path.join(ROOT, "renderer/src/main.ts"), "utf8");
  const mount = fs.readFileSync(path.join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  const container = fs.readFileSync(path.join(VENDOR, "pkg/container.js"), "utf8");
  const host = fs.readFileSync(path.join(ROOT, "host/wallpaper-host.ts"), "utf8");
  const resume = (main.match(/  resume\(\) \{[\s\S]*?\n  \w+\(/) || [""])[0];
  check(
    resume.length > 0 && !/mount(Wallpaper)?\(\s*rt,?\s*rt\.cfg\s*\)/.test(resume),
    "resume 不得整包重挂（应重启 rAF / 恢复当时在播的媒体）",
  );
  check(
    !/if \(rt\.cfg\.type === "scene"\) mountWallpaper\(rt, rt\.cfg\)/.test(main),
    "updateWebProps 不得对场景壁纸整包重挂（应就地改效果链与 applyUserProperties）",
  );
  check(
    /rt\.sceneCtl/.test(main) && /applyUserProperties/.test(main) && /sceneCtl/.test(mount),
    "pause/resume/updateWebProps 必须接到 sceneCtl（渲染循环闭包在 scene-mount 里）",
  );
  check(
    /pkg cache hit/.test(mount) && /pkgCache/.test(mount),
    "scene-mount 必须缓存已读完的 scene.pkg（同壁纸暂停/重挂不要再拉 100MB+）",
  );
  check(
    !/\.subarray\(\s*start\s*,\s*end\s*\)\.slice\(\s*\)/.test(container),
    "getEntry 不得 .slice() 复制整段入口（大 pkg 峰值内存会翻倍）",
  );
  check(
    /ETag/.test(host) && /max-age/.test(host),
    "wallpaper-host 静态资源必须带 ETag / max-age（刷新时大 pkg 走 304 或磁盘缓存）",
  );
  check(
    /applyLiveProps/.test(mount) && /resolveUserProps/.test(mount) && /mergeUserPropertyValues/.test(mount),
    "scene-mount 必须就地 resolveUserProps + applyUserProperties 热更属性",
  );
}

// ---------- 汇总 ----------
if (errors.length) {
  console.error(`verify-arch：${errors.length} 处边界破坏`);
  for (const e of errors) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`verify-arch：边界完好（${jsFiles.length} 个引擎模块全部 Node 可加载，依赖方向与契约面无违规）`);
