// 使用说明文档（活动栏「使用说明」标签页的内容源）
//
// 结构化双语内容：改文档只动这个文件。代码块里的注释也随语言切换。

import { t, type Lang } from "./i18n";

export type Bi = { zh: string; en: string };
export type DocBlock =
  | { k: "p"; v: Bi }
  | { k: "code"; v: Bi }
  | { k: "ul"; items: Bi[] }
  | { k: "links"; items: { label: Bi; href: string }[] }
  | { k: "table"; head: Bi[]; rows: Bi[][]; codeCols?: number[] };

export type DocSection = { id: string; title: Bi; blocks: DocBlock[] };

export const DOC: DocSection[] = [
  {
    id: "intro",
    title: { zh: "简介", en: "Introduction" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "WebWallGL 是一个浏览器端的 Wallpaper Engine「scene」场景、视频、web（后续版本支持）壁纸渲染库：主要功能是把创意工坊场景包（scene.pkg）在 WebGL 里实时还原，支持图层效果链、粒子、3D 木偶骨骼、文字挂件、脚本沙箱、音频响应与用户自定义属性热更新。后续版本将加入本库独有效果支持，请敬请期待。",
          en: "WebWallGL is a browser-side renderer for Wallpaper Engine wallpapers — \"scene\" today, with video and web support coming in later releases: its main job is replaying workshop scene packages (scene.pkg) in WebGL in real time, with layer effect chains, particles, 3D puppet bones, text widgets, script sandboxes, audio response and live user-property updates. Upcoming versions will add effects exclusive to this library — stay tuned.",
        },
      },
      {
        k: "links",
        items: [
          { label: { zh: "GitHub 开源仓库", en: "GitHub repository" }, href: "https://github.com/oneincase/webwallgl" },
          { label: { zh: "在线版（GitHub Pages）", en: "Live demo (GitHub Pages)" }, href: "https://oneincase.github.io/webwallgl/" },
        ],
      },
      {
        k: "ul",
        items: [
          { zh: "零运行时依赖，单文件引入（min ESM 约 270KB / gzip 约 90KB）", en: "Zero runtime dependencies, single-file delivery (min ESM ~270KB / gzip ~90KB)" },
          { zh: "可 npm 安装，也可 <script> CDN 引入；一页可开多个互不干扰的实例", en: "Installable via npm or a <script> CDN tag; multiple isolated instances per page" },
          { zh: "本测试台本身就是库的第一个使用者 —— 你在这里看到的能力都是公共 API", en: "This bench is the library's first consumer — everything you see here is public API" },
        ],
      },
    ],
  },
  {
    id: "what",
    title: { zh: "能做什么", en: "What can you build" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "WebWallGL 是一个「壁纸兼容渲染核心」——凡是需要「动态背景」的地方，都可以塞一个 WebWallGL 实例进去：",
          en: "WebWallGL is a 'wallpaper-compatible rendering core' — anywhere a \"dynamic background\" is needed, drop in a WebWallGL instance:",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "壁纸软件：桌面壁纸引擎（Tauri / Electron / WebView 壳）的核心渲染器，完整还原 WE 创意工坊场景", en: "Wallpaper apps: the core renderer for desktop wallpaper engines (Tauri / Electron / WebView shells), fully replaying WE workshop scenes" },
          { zh: "网页：个人主页、落地页、产品官网的动态背景或全屏 hero 区块", en: "Websites: animated backgrounds or full-screen hero sections for homepages, landing pages and product sites" },
          { zh: "各类代码工具：仪表盘、监控大屏、终端（如 GUI 启动器/开发工具）的背景层", en: "Dev tools: background layers for dashboards, monitoring walls, terminals and GUI launchers" },
          { zh: "背景插件：音乐播放器可视化、直播 OBS 背景板、数字标牌、kye/小部件引擎的嵌入渲染源", en: "Background plugins: embedded render source for music visualizers, OBS backdrops, digital signage and widget engines" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "一句话：万物皆可 Wall。你的应用只负责提供一块 canvas 和场景包的来源，剩下的解析、装配、渲染循环、脚本沙箱、指针与音频，全部交给 WebWallGL。",
          en: "In one line: everything can be a wall. Your app provides a canvas and a source for the scene package — parsing, assembly, the render loop, script sandboxes, pointer and audio are all WebWallGL's job.",
        },
      },
    ],
  },
  {
    id: "install",
    title: { zh: "安装", en: "Installation" },
    blocks: [
      { k: "p", v: { zh: "三种引入方式，任选其一（CDN 示例按当前发布版本固定）：", en: "Three ways to include it — pick one (CDN examples pin the currently released version):" } },
      {
        k: "code",
        v: {
          zh: "// 1) npm + 打包器（推荐）\nnpm i webwallgl           // 追最新版；锁定测试版用 npm i webwallgl@beta\nimport { mount, httpSource } from \"webwallgl\";",
          en: "// 1) npm + bundler (recommended)\nnpm i webwallgl           // tracks the latest release; pin the test build with npm i webwallgl@beta\nimport { mount, httpSource } from \"webwallgl\";",
        },
      },
      {
        k: "code",
        v: {
          zh: "// 2) ESM CDN（jsDelivr，vite/webpack 之外的直引方式）\nimport { mount, httpSource } from \"https://cdn.jsdelivr.net/npm/webwallgl@1.0.0-beta1/webwallgl.min.mjs\";",
          en: "// 2) ESM CDN via jsDelivr (without a bundler)\nimport { mount, httpSource } from \"https://cdn.jsdelivr.net/npm/webwallgl@1.0.0-beta1/webwallgl.min.mjs\";",
        },
      },
      {
        k: "code",
        v: {
          zh: "<!-- 3) UMD <script>：暴露全局 WebWallGL -->\n<script src=\"https://cdn.jsdelivr.net/npm/webwallgl@1.0.0-beta1/webwallgl.global.min.js\"></script>\n<script>\n  const { mount, httpSource } = WebWallGL;\n</script>",
          en: "<!-- 3) UMD <script>: exposes the global WebWallGL -->\n<script src=\"https://cdn.jsdelivr.net/npm/webwallgl@1.0.0-beta1/webwallgl.global.min.js\"></script>\n<script>\n  const { mount, httpSource } = WebWallGL;\n</script>",
        },
      },
    ],
  },
  {
    id: "quickstart",
    title: { zh: "快速开始", en: "Quick start" },
    blocks: [
      { k: "p", v: { zh: "一个 canvas + 一个资源来源就是全部。mount() 在首帧真正画出来之后 resolve：", en: "One canvas plus one source is everything. mount() resolves after the first frame is actually drawn:" } },
      {
        k: "code",
        v: {
          zh: "<canvas id=\"wp\" style=\"width:100%;height:400px\"></canvas>\n\nimport { mount, httpSource } from \"webwallgl\";\n\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/3122339805\"),\n  fps: 60,\n});\n\n// 首帧之后实例即可用：\nwp.pause();\nwp.resume();\nwp.setProperties({ schemecolor: \"0.5 0.2 0.8\" });\nconsole.log(\"实测帧率\", wp.stats.fps);",
          en: "<canvas id=\"wp\" style=\"width:100%;height:400px\"></canvas>\n\nimport { mount, httpSource } from \"webwallgl\";\n\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/3122339805\"),\n  fps: 60,\n});\n\n// The instance is ready to use after the first frame:\nwp.pause();\nwp.resume();\nwp.setProperties({ schemecolor: \"0.5 0.2 0.8\" });\nconsole.log(\"live fps:\", wp.stats.fps);",
        },
      },
      {
        k: "p",
        v: {
          zh: "画布的 CSS 尺寸就是渲染尺寸：库把 backing store 对齐 clientWidth/clientHeight，容器改大小后画面宽高比自动跟随，不需要手动 resize。",
          en: "The canvas CSS size is the render size: the library aligns the backing store to clientWidth/clientHeight, and the aspect follows container resizes automatically — no manual resize handling.",
        },
      },
    ],
  },
  {
    id: "source",
    title: { zh: "资源来源 Source", en: "Loading scenes: Source" },
    blocks: [
      { k: "p", v: { zh: "库对网络只发两个请求（scene.pkg 与可选的 project.json），所以资源抽象只有一个接口、三个内置实现：", en: "The library makes only two network requests (scene.pkg and optional project.json), so the resource abstraction is one interface with three built-in implementations:" } },
      {
        k: "table",
        codeCols: [0],
        head: [
          { zh: "工厂", en: "Factory" },
          { zh: "用途", en: "Use case" },
        ],
        rows: [
          [{ zh: "httpSource(baseUrl, init?)", en: "httpSource(baseUrl, init?)" }, { zh: "HTTP 基址；自动按 scene.pkg → scenes/scene.pkg → gifscene.pkg 三种真实布局回退", en: "HTTP base URL; falls back through the three real layouts: scene.pkg → scenes/scene.pkg → gifscene.pkg" }],
          [{ zh: "fileSource(file, project?)", en: "fileSource(file, project?)" }, { zh: "<input type=file> 或拖拽进来的 .pkg 本地文件", en: "A local .pkg from <input type=file> or drag & drop" }],
          [{ zh: "bytesSource(pkg, project?, key?)", en: "bytesSource(pkg, project?, key?)" }, { zh: "已经拿到字节（bundle 内嵌、IndexedDB 缓存、自定义通道）", en: "Bytes already in hand (bundled, IndexedDB cache, custom transport)" }],
        ],
      },
      {
        k: "code",
        v: {
          zh: "// 本地文件：拖一个 scene.pkg 进页面即可预览\ninput.addEventListener(\"change\", () => {\n  const src = fileSource(input.files[0]);\n  mount(canvas, { source: src });\n});",
          en: "// Local file: drop a scene.pkg into the page to preview it\ninput.addEventListener(\"change\", () => {\n  const src = fileSource(input.files[0]);\n  mount(canvas, { source: src });\n});",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "httpSource 必须先试根目录 scene.pkg，且每个 fetch 单独容错 —— WKWebView/自定义协议对缺失路径抛 Failed to fetch 而不是 404，顺序错了会「一片壁纸全坏」", en: "httpSource tries the root scene.pkg first and tolerates each fetch separately — WKWebView/custom protocols throw Failed to fetch instead of a 404; the wrong order breaks every wallpaper" },
          { zh: "source.key 参与库内解析缓存：相同 key 的包不会重复解析（暂停/改属性零网络）", en: "source.key feeds the library's parse cache: packages with the same key are parsed once (pause/property changes cost zero network)" },
          { zh: "project 缺失是常态：没有属性表时场景字段用 scene.json 内的快照值", en: "A missing project.json is normal: without a property table, fields fall back to the scene.json snapshot values" },
        ],
      },
    ],
  },
  {
    id: "mount-options",
    title: { zh: "挂载选项 MountOptions", en: "Mount options" },
    blocks: [
      {
        k: "table",
        codeCols: [0, 1],
        head: [
          { zh: "选项", en: "Option" },
          { zh: "默认", en: "Default" },
          { zh: "说明", en: "Description" },
        ],
        rows: [
          [{ zh: "source（必填）", en: "source (required)" }, { zh: "—", en: "—" }, { zh: "见上节 Source", en: "See Source above" }],
          [{ zh: "fit", en: "fit" }, { zh: "\"cover\"", en: "\"cover\"" }, { zh: "cover 等比裁切铺满 / contain 等比留边 / stretch 拉伸", en: "cover crops to fill / contain letterboxes / stretch distorts" }],
          [{ zh: "renderDpr", en: "renderDpr" }, { zh: "1", en: "1" }, { zh: "渲染 DPR 上限（实际取 min(devicePixelRatio, renderDpr)），调低省显存", en: "Render DPR cap (effective = min(devicePixelRatio, renderDpr)); lower it to save VRAM" }],
          [{ zh: "fps", en: "fps" }, { zh: "60", en: "60" }, { zh: "帧率上限；被上限跳过的帧不计入 stats.fps，掉帧一眼可见", en: "FPS cap; skipped frames don't count into stats.fps, so drops are visible" }],
          [{ zh: "volume", en: "volume" }, { zh: "0", en: "0" }, { zh: "0..1。默认静音起步（浏览器自动播放策略）；就绪后再设非零音量", en: "0..1. Starts muted (autoplay policy); set a non-zero volume after ready" }],
          [{ zh: "autoplay", en: "autoplay" }, { zh: "true", en: "true" }, { zh: "false 时挂载后保持暂停", en: "When false, stays paused after mount" }],
          [{ zh: "properties", en: "properties" }, { zh: "{}", en: "{}" }, { zh: "初始用户属性覆盖值（键为属性名）", en: "Initial user property overrides (keys are property names)" }],
          [{ zh: "pointer / audio / media", en: "pointer / audio / media" }, { zh: "内置", en: "built-in" }, { zh: "指针跟随 canvas、音频/系统媒体为确定性模拟；传 null 禁用", en: "Pointer follows the canvas; audio/media are deterministic sims; pass null to disable" }],
          [{ zh: "features", en: "features" }, { zh: "全开", en: "all on" }, { zh: "调试开关：models / text / particles / effects / components", en: "Debug switches: models / text / particles / effects / components" }],
          [{ zh: "onReady / onError / onDiagnostic", en: "onReady / onError / onDiagnostic" }, { zh: "—", en: "—" }, { zh: "回调面；也可之后用 instance.on() 订阅", en: "Callback surface; can also subscribe later via instance.on()" }],
        ],
      },
    ],
  },
  {
    id: "instance",
    title: { zh: "实例 API SceneInstance", en: "The SceneInstance API" },
    blocks: [
      {
        k: "table",
        codeCols: [0],
        head: [
          { zh: "成员", en: "Member" },
          { zh: "说明", en: "Description" },
        ],
        rows: [
          [{ zh: "pause() / resume() / paused", en: "pause() / resume() / paused" }, { zh: "暂停恢复。禁止整包重挂：恢复时视频/音频从暂停点继续", en: "Pause/resume. Never remounts the package: video/audio resume from where they were" }],
          [{ zh: "setFit(fit) / setFps(n) / setVolume(v)", en: "setFit(fit) / setFps(n) / setVolume(v)" }, { zh: "热更新，无需重挂载（渲染循环每帧读取）", en: "Live updates, no remount (the render loop reads them per frame)" }],
          [{ zh: "setRenderDpr(dpr)", en: "setRenderDpr(dpr)" }, { zh: "改 DPR 需重建画布，内部自动重挂（pkg 缓存命中，不重新下载）", en: "Changing DPR rebuilds the canvas; remounts internally (pkg cache hit, no re-download)" }],
          [{ zh: "setProperties(props)", en: "setProperties(props)" }, { zh: "属性热更新：就地改属性表/效果常量/脚本沙箱，不重新拉包", en: "Live property updates: patches the property table / effect constants / script sandboxes in place, no re-fetch" }],
          [{ zh: "getProperties()", en: "getProperties()" }, { zh: "当前生效的扁平化属性值表", en: "The current flattened property value map" }],
          [{ zh: "load(source)", en: "load(source)" }, { zh: "换场景，复用同一 canvas 与 WebGL 上下文；首帧后 resolve", en: "Switch scenes reusing the same canvas and WebGL context; resolves after the first frame" }],
          [{ zh: "release() / restore()", en: "release() / restore()" }, { zh: "释放显存但保留配置（显示器睡眠）/ 用保留的配置重建", en: "Free GL resources keeping the config (display sleep) / rebuild from the kept config" }],
          [{ zh: "destroy()", en: "destroy()" }, { zh: "终态：释放资源、解绑监听，之后实例不可再用", en: "Terminal: frees resources, unbinds listeners; the instance is dead afterwards" }],
          [{ zh: "stats / info", en: "stats / info" }, { zh: "实测帧率（{fps, running}，停了会归零而不是冻住）/ 场景基本信息（逻辑分辨率、图层数、是否含模型/粒子/文字）", en: "Measured FPS ({fps, running}, zeroes out instead of freezing) / scene info (logical size, layer count, has models/particles/text)" }],
          [{ zh: "on(ev, fn)", en: "on(ev, fn)" }, { zh: "订阅 ready / error / diagnostic，返回取消函数", en: "Subscribe to ready / error / diagnostic; returns an unsubscribe function" }],
        ],
      },
    ],
  },
  {
    id: "events",
    title: { zh: "事件与诊断", en: "Events & diagnostics" },
    blocks: [
      {
        k: "code",
        v: {
          zh: "const off = wp.on(\"diagnostic\", (msg, level) => {\n  // level: \"info\" | \"warn\" | \"error\"\n  console[level === \"error\" ? \"error\" : \"log\"](\"[wp]\", msg);\n});\nwp.on(\"error\", (err) => showError(err));\nwp.on(\"ready\", (info) => {\n  // info: { width, height, layerCount, hasModels, hasParticles, hasText }\n});",
          en: "const off = wp.on(\"diagnostic\", (msg, level) => {\n  // level: \"info\" | \"warn\" | \"error\"\n  console[level === \"error\" ? \"error\" : \"log\"](\"[wp]\", msg);\n});\nwp.on(\"error\", (err) => showError(err));\nwp.on(\"ready\", (info) => {\n  // info: { width, height, layerCount, hasModels, hasParticles, hasText }\n});",
        },
      },
      {
        k: "p",
        v: {
          zh: "库不自带降级页，也不向任何服务器上报：诊断与错误全部经回调交给你，渲染失败的兜底（提示、换壁纸、卸载实例）由调用方决定。",
          en: "The library ships no fallback page and phones home nowhere: diagnostics and errors arrive via callbacks only. What to do on failure (show a hint, swap the wallpaper, destroy the instance) is your call.",
        },
      },
    ],
  },
  {
    id: "multi",
    title: { zh: "一页多实例", en: "Multiple instances per page" },
    blocks: [
      {
        k: "code",
        v: {
          zh: "const a = await mount(c1, { source: httpSource(urlA) });\nconst b = await mount(c2, { source: httpSource(urlB) });\nb.pause(); // 不影响 a",
          en: "const a = await mount(c1, { source: httpSource(urlA) });\nconst b = await mount(c2, { source: httpSource(urlB) });\nb.pause(); // does not affect a",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "每个实例持独立的 Runtime：配置、帧率计、WebGL 上下文、属性表互不可见", en: "Each instance owns a Runtime: config, FPS meter, WebGL context and property table are fully isolated" },
          { zh: "指针事件挂在各自的 canvas 上，归一化坐标相对画布，不会截获整页输入", en: "Pointer events bind to each instance's canvas; normalized coordinates are canvas-relative and never capture the page" },
          { zh: "注意 WebGL 上下文数量：浏览器一般允许同页 8~16 个，超出会丢最旧的上下文", en: "Mind WebGL context limits: browsers allow ~8–16 per page and drop the oldest beyond that" },
        ],
      },
    ],
  },
  {
    id: "lifecycle",
    title: { zh: "生命周期与缓存", en: "Lifecycle & caching" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "解析后的 scene.pkg 按 source.key 缓存（最多 2 份）：暂停恢复、改属性、setRenderDpr 重挂都不重新下载", en: "Parsed scene.pkg entries are cached by source.key (up to 2): pause/resume, property changes and setRenderDpr remounts never re-download" },
          { zh: "release() 后 stats.running 变 false、读数归零 —— 停住的读数不该冻在最后一个值上", en: "After release(), stats.running goes false and the FPS reading zeroes out — a stopped meter must not freeze on its last value" },
          { zh: "destroy() 之后 canvas 归还给你，库不再碰它；可以再 mount() 一个新实例", en: "After destroy() the canvas is yours again; mount() a fresh instance any time" },
        ],
      },
    ],
  },
  {
    id: "troubleshooting",
    title: { zh: "故障排查", en: "Troubleshooting" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "黑屏且 onError 报 WEBGL2_UNAVAILABLE：环境没有 WebGL2，库不做软件回退", en: "Black screen with WEBGL2_UNAVAILABLE: no WebGL2 in this environment; there is no software fallback" },
          { zh: "HTTP 404 加载失败：确认 httpSource 指向的目录里真的有 scene.pkg（三种布局会依次尝试，全部失败才报错）", en: "HTTP 404: make sure the httpSource directory really contains a scene.pkg (all three layouts are tried before failing)" },
          { zh: "Failed to fetch 且无状态码：自定义协议/WKWebView 对缺失路径的行为，属正常容错路径，看最后一条错误即可", en: "Failed to fetch with no status: custom-protocol/WKWebView behavior for missing paths — by design; just read the final error" },
          { zh: "stats.fps 为 0 但画面在动：读数是「真正提交渲染」的帧，标签页被遮挡时浏览器会暂停 rAF，属预期", en: "stats.fps is 0 while the picture moves: the meter counts committed frames only; browsers suspend rAF for occluded tabs — expected" },
          { zh: "有声音但延迟起播：自动播放策略要求用户交互后才允许出声，volume 默认 0 正是为此", en: "Audio starts late: autoplay policy requires user interaction before sound; that's why volume defaults to 0" },
        ],
      },
    ],
  },
  {
    id: "compliance",
    title: { zh: "版权与合规", en: "Copyright & compliance" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "库代码 MIT。Wallpaper Engine 创意工坊素材（scene.pkg、贴图、音视频）版权归各自作者所有：请仅指向你自己拥有或已获授权的素材，不要把他人作品打包进你的产品或公网分发。",
          en: "The library code is MIT. Wallpaper Engine workshop assets (scene.pkg, textures, audio/video) remain copyrighted by their authors: point the library only at content you own or are licensed to use, and don't redistribute other people's work through your product.",
        },
      },
    ],
  },
];

/** 把文档渲染进容器；语言切换时重新渲染 */
export function renderDocs(body: HTMLElement, lang: Lang) {
  body.textContent = "";
  for (const sec of DOC) {
    const h2 = document.createElement("h2");
    h2.id = `doc-${sec.id}`;
    h2.textContent = sec.title[lang];
    body.appendChild(h2);
    for (const b of sec.blocks) {
      if (b.k === "p") {
        const p = document.createElement("p");
        p.textContent = b.v[lang];
        body.appendChild(p);
      } else if (b.k === "code") {
        const pre = document.createElement("pre");
        pre.className = "doc-code";
        pre.textContent = b.v[lang];
        body.appendChild(pre);
      } else if (b.k === "ul") {
        const ul = document.createElement("ul");
        for (const it of b.items) {
          const li = document.createElement("li");
          li.textContent = it[lang];
          ul.appendChild(li);
        }
        body.appendChild(ul);
      } else if (b.k === "links") {
        const p = document.createElement("p");
        p.className = "doc-links";
        b.items.forEach((it, i) => {
          if (i > 0) p.appendChild(document.createTextNode(" · "));
          const a = document.createElement("a");
          a.href = it.href;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = it.label[lang];
          p.appendChild(a);
        });
        body.appendChild(p);
      } else {
        const table = document.createElement("table");
        table.className = "doc-table";
        const thead = document.createElement("thead");
        const trh = document.createElement("tr");
        for (const h of b.head) {
          const th = document.createElement("th");
          th.textContent = h[lang];
          trh.appendChild(th);
        }
        thead.appendChild(trh);
        table.appendChild(thead);
        const tbody = document.createElement("tbody");
        for (const row of b.rows) {
          const tr = document.createElement("tr");
          row.forEach((cell, ci) => {
            const td = document.createElement("td");
            if (b.codeCols?.includes(ci)) {
              const code = document.createElement("code");
              code.textContent = cell[lang];
              td.appendChild(code);
            } else {
              td.textContent = cell[lang];
            }
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        body.appendChild(table);
      }
    }
  }
}
