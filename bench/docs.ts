// 使用说明文档（活动栏「使用说明」标签页的内容源）
//
// 结构化双语内容：改文档只动这个文件。代码块里的注释也随语言切换。

import { t, type Lang } from "./i18n";

// 读取 package.json 中的 version 字段（vite 与 esbuild 均原生支持 JSON 导入，
// 浏览器构建与 gen-readme 的 Node 打包两条路都能走通，不能用 fs/path）
import pkg from "../package.json";
const version = pkg.version;
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
          zh: "让 Wallpaper Engine 实现再次伟大！！！恭喜你发现宝藏，这是全网复刻程度最高，功能最强，更新最快的 Wallpaper Engine 自研核心库，纯 TypeScript/JS 实现。webwallgl 是一个浏览器端的 Wallpaper Engine「scene」场景、视频、web 网页壁纸渲染库：主要功能是把创意工坊场景包（scene.pkg）在 WebGL 里实时还原，支持图层效果链、粒子、3D 木偶骨骼、文字挂件、脚本沙箱、场景灯光（PBR 直射光）与 HDR 色调映射、音频响应与用户自定义属性热更新；网页类型壁纸经 sandbox iframe + 加载前 WE shim 注入运行。后续版本将加入本库独有效果支持，请敬请期待。下游如果进行了库的引用，麻烦给个 star，非常感谢！",
          en: "Make Wallpaper Engine great again!!! Congratulations — you've found a treasure. This is the most faithful, most feature-complete, and fastest-updated self-built Wallpaper Engine core on the web, implemented in pure TypeScript/JS. WebWallGL is a browser-side renderer for Wallpaper Engine wallpapers — scene, video, and web: its main job is replaying workshop scene packages (scene.pkg) in WebGL in real time, with layer effect chains, particles, 3D puppet bones, text widgets, script sandboxes, scene lighting (PBR direct light) with HDR tone mapping, audio response and live user-property updates; web wallpapers run in a sandboxed iframe with a WE API shim injected before author scripts. Upcoming versions will add effects exclusive to this library — stay tuned. If your project uses this library, please give it a star — many thanks!",
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
          { zh: "零运行时依赖，单文件引入（min ESM 约 930KB / gzip 约 295KB）", en: "Zero runtime dependencies, single-file delivery (min ESM ~930KB / gzip ~295KB)" },
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
          zh: `// 2) ESM CDN（jsDelivr，vite/webpack 之外的直引方式）\nimport { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@${version}/webwallgl.min.mjs";`,
          en: `// 2) ESM CDN via jsDelivr (without a bundler)\nimport { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@${version}/webwallgl.min.mjs";`,
        },
      },
      {
        k: "code",
        v: {
          zh: `<!-- 3) UMD <script>：暴露全局 WebWallGL -->\n<script src="https://cdn.jsdelivr.net/npm/webwallgl@${version}/webwallgl.global.min.js"></script>\n<script>\n  const { mount, httpSource } = WebWallGL;\n</script>`,
          en: `<!-- 3) UMD <script>: exposes the global WebWallGL -->\n<script src="https://cdn.jsdelivr.net/npm/webwallgl@${version}/webwallgl.global.min.js"></script>\n<script>\n  const { mount, httpSource } = WebWallGL;\n</script>`,
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
    id: "mount-target",
    title: { zh: "挂载目标：canvas 还是容器 div", en: "Mount target: canvas or container div" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "mount() 的第一个参数收任意 HTMLElement，不限于 canvas。传 canvas 就直接用它；传普通容器（div 等）则库在其内部自建一块铺满的 canvas（带 data-webwallgl 标记，重复挂载会复用同一块，容器若是 position:static 会被改成 relative）。",
          en: "mount() takes any HTMLElement as its first argument, not just a canvas. Pass a canvas and it is used directly; pass a plain container (a div, say) and the library creates a full-bleed canvas inside it (tagged data-webwallgl, reused on remount; a position:static container is switched to relative).",
        },
      },
      {
        k: "p",
        v: {
          zh: "选哪个不是风格问题——**网页类型壁纸必须传容器**。网页壁纸不走 WebGL，库会把 sandbox iframe 直接 appendChild 进你传的元素；canvas 不能有子元素，传 canvas 会挂不上。如果同一段代码要同时应付场景壁纸和网页壁纸（例如一个通用壁纸播放器），一律传 div 最稳妥：",
          en: "This is not a style choice — **web wallpapers require a container**. A web wallpaper does not use WebGL; the library appendChild()s a sandboxed iframe into the element you pass, and a canvas cannot have children, so passing one fails. If the same code path must handle both scene and web wallpapers (a general wallpaper player, say), always pass a div:",
        },
      },
      {
        k: "code",
        v: {
          zh: "<!-- 通用写法：两类壁纸都能挂 -->\n<div id=\"wp\" style=\"position:relative;width:100%;height:400px\"></div>\n\n// 场景壁纸：库在 div 内自建 canvas\n// 网页壁纸：库在 div 内挂 sandbox iframe\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/2517518192\"),\n});\n\n// wp.canvas 始终可读：场景路径是那块真 canvas，网页路径是你传入的容器\nconsole.log(wp.canvas);",
          en: "<!-- Works for both wallpaper types -->\n<div id=\"wp\" style=\"position:relative;width:100%;height:400px\"></div>\n\n// Scene wallpaper: the library builds a canvas inside the div\n// Web wallpaper:   the library mounts a sandboxed iframe inside the div\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/2517518192\"),\n});\n\n// wp.canvas is always readable: the real canvas on the scene path,\n// the container you passed on the web path\nconsole.log(wp.canvas);",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "类型不用你判断：mount() 先取 project.json，type 为 \"web\" 走网页路径，其余一律走场景装配", en: "You never branch on type yourself: mount() reads project.json first — type \"web\" takes the web path, everything else goes through scene assembly" },
          { zh: "网页入口 URL 的解析顺序是 Source.webEntry() → {httpSource 基址}/{project.file 或 index.html}；两者都给不出就抛错", en: "The web entry URL resolves as Source.webEntry() → {httpSource base}/{project.file or index.html}; if neither yields a URL, mount throws" },
          { zh: "网页路径下 fit / renderDpr / features 这些 WebGL 侧选项自然不适用；pause/resume、setVolume、setProperties 仍然有效（同源经 shim 直访转达给作者代码；跨源或 webSandbox: \"strict\" 时自动改走 postMessage 控制通道，指针/滚轮/音频/媒体同此）", en: "On the web path the WebGL-side options (fit / renderDpr / features) do not apply; pause/resume, setVolume and setProperties still work — relayed to author code through the shim on same-origin access, and automatically over the postMessage control channel when cross-origin or under webSandbox: \"strict\" (pointer/wheel/audio/media travel the same way)" },
        ],
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
          [{ zh: "renderDpr", en: "renderDpr" }, { zh: "0（自动）", en: "0 (auto)" }, { zh: "渲染 DPR：0=跟随设备 devicePixelRatio（Retina/HiDPI 原生清晰）；正数=目标 DPR，可高于设备上报值（宿主 WKWebView 误报 1 时仍能超采样到物理分辨率）。物理最长边封顶 4096，调低省显存。该档位同时决定贴图资源倍率（档位越低，贴图按图层足迹选得越小，见下节「显存与清晰度」）", en: "Render DPR: 0 = follow devicePixelRatio (native-sharp on Retina/HiDPI); a positive number = target DPR and may exceed the reported device value (supersamples to physical resolution even when a host WKWebView misreports 1). Physical long edge capped at 4096; lower it to save VRAM. The tier also drives the texture resource scale — at lower tiers textures resolve to smaller sizes per layer footprint (see \"VRAM & clarity\" below)" }],
          [{ zh: "fps", en: "fps" }, { zh: "60", en: "60" }, { zh: "帧率上限；被上限跳过的帧不计入 stats.fps，掉帧一眼可见", en: "FPS cap; skipped frames don't count into stats.fps, so drops are visible" }],
          [{ zh: "volume", en: "volume" }, { zh: "0", en: "0" }, { zh: "0..1。默认静音起步（浏览器自动播放策略）；就绪后再设非零音量", en: "0..1. Starts muted (autoplay policy); set a non-zero volume after ready" }],
          [{ zh: "autoplay", en: "autoplay" }, { zh: "true", en: "true" }, { zh: "false 时挂载后保持暂停", en: "When false, stays paused after mount" }],
          [{ zh: "properties", en: "properties" }, { zh: "{}", en: "{}" }, { zh: "初始用户属性覆盖值（键为属性名）", en: "Initial user property overrides (keys are property names)" }],
          [{ zh: "pointer / audio / media", en: "pointer / audio / media" }, { zh: "内置", en: "built-in" }, { zh: "指针跟随 canvas；音频/系统媒体无注入时为占位源（频谱恒静默、「无媒体」快照，壁纸显示作者烘焙的占位外观）；传 null 禁用", en: "Pointer follows the canvas; with nothing injected, audio/media run placeholder sources (silent spectrum, a \"no media\" snapshot — the wallpaper shows its author-baked placeholder look); pass null to disable" }],
          [{ zh: "features", en: "features" }, { zh: "全开", en: "all on" }, { zh: "调试开关：models / text / particles / effects / components", en: "Debug switches: models / text / particles / effects / components" }],
          [{ zh: "webSandbox", en: "webSandbox" }, { zh: "\"legacy\"", en: "\"legacy\"" }, { zh: "网页壁纸 iframe 沙箱档：legacy = allow-scripts + allow-same-origin（默认，与 WallpaperEM 一致）；strict = 只给 allow-scripts（宿主与壁纸共享 origin 时，防作者脚本以宿主身份调用宿主 API）。strict 下控制/指针/滚轮/音频/媒体自动改走 postMessage 通道，API 面完全一致", en: "Web wallpaper iframe sandbox tier: legacy = allow-scripts + allow-same-origin (default, WallpaperEM behavior); strict = allow-scripts only (when the host shares its origin with the wallpaper, so author scripts cannot act as the host). Under strict, control/pointer/wheel/audio/media automatically travel over a postMessage channel — the API surface is identical" }],
          [{ zh: "quality", en: "quality" }, { zh: "全默认", en: "all defaults" }, { zh: "渲染质量档位（对标 WE 客户端性能选项）：antiAliasing: \"off\"（默认）/\"fxaa\"/\"msaa2\"/\"msaa4\"、particles: \"high\"（默认）/\"medium\"/\"low\"/\"off\"（低/中档按倍率同时缩数量上限与发射率）、postProcessing: \"high\"（默认）/\"medium\"/\"low\"/\"off\"（低/中档压效果链 FBO 分辨率；off=效果链直通+跳整屏后期层+关 Bloom）。超采样走 renderDpr", en: "Render quality tiers (like the WE client's performance options): antiAliasing \"off\" (default)/\"fxaa\"/\"msaa2\"/\"msaa4\", particles \"high\" (default)/\"medium\"/\"low\"/\"off\" (low/medium scale both the count cap and emission rate), postProcessing \"high\" (default)/\"medium\"/\"low\"/\"off\" (low/medium cap effect-chain FBO resolution; off bypasses effect chains, fullscreen post layers and Bloom). Supersampling lives in renderDpr" }],
          [{ zh: "autoQuality", en: "autoQuality" }, { zh: "true", en: "true" }, { zh: "自动降档（**只填你没显式指定的键**）：① 探到**软件渲染（无 GPU）**时自动关后处理并把画布 DPR 压到 0.5；② 运行期帧率连续 3 秒低于上限 85% 时把后处理降一档（high→medium→low→off，只降不升，每档间隔 6 秒）。显式的 quality.postProcessing 永远优先；传 false 整体关闭（query ?autoq=0 同效）。实际生效值读 getQuality()", en: "Automatic downgrade (only fills keys you did not set explicitly): (1) on **software rendering (no GPU)** it disables post-processing and caps the canvas DPR at 0.5; (2) at runtime, 3 consecutive seconds below 85% of the fps cap downgrades post-processing one step (high→medium→low→off, down-only, 6s between steps). An explicit quality.postProcessing always wins; pass false to turn it off (?autoq=0 equivalent). Read getQuality() for the effective values" }],
          [{ zh: "bake", en: "bake" }, { zh: "true", en: "true" }, { zh: "贴图烘焙（B3）：内嵌 PNG/JPEG 的**预缩放缓存**，默认开（传 false / query ?bake=0 关闭）。内嵌图的现状路径是「解全尺寸再缩」，实测大图最贵的就是这一步；命中缓存后只做一次解码（52 张内嵌图实测解码 470ms → 94ms，-80%；端到端 TTFF 热加载 -14%，冷加载与不烘持平），**像素与不烘时逐位一致**（缓存存的是处理完 EXIF 回滚后的最终位图）。未命中走原路径并把结果排进后台队列（首帧后才开跑，不拖慢本次加载）；键 = 壁纸指纹 + 贴图指纹 + 资源档位，窗口缩放不会导致重烘", en: "Texture baking (B3): a **pre-scaled cache for embedded PNG/JPEG** textures, on by default (pass false / ?bake=0 to disable). The current path decodes full-size then resizes — that decode is the expensive part; a cache hit does a single decode instead (measured on 52 embedded images: 470ms → 94ms of decode, -80%; end-to-end TTFF -14% on warm loads, cold loads unchanged), **pixels identical to not baking** (the cache stores the final bitmap after the EXIF rollback). A miss keeps the current path and queues the result for background baking (drains after the first frame, so it never slows the current load). Key = wallpaper fingerprint + texture fingerprint + resource tier, so window resizes never trigger a re-bake" }],
          [{ zh: "onReady / onError / onDiagnostic", en: "onReady / onError / onDiagnostic" }, { zh: "—", en: "—" }, { zh: "回调面；也可之后用 instance.on() 订阅", en: "Callback surface; can also subscribe later via instance.on()" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "显存与清晰度：显存的大头是纹理与画布/效果链缓冲，两者都随挂载选项自动伸缩，不需要手动管理——",
          en: "VRAM & clarity: textures plus canvas/effect-chain buffers dominate VRAM, and both scale automatically with the mount options — no manual management required:",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "贴图按「清晰度 × 图层在屏幕上的实际足迹」自动选分辨率：只要贴图分辨率 ≥ 图层的设备像素足迹，画面与全分辨率素材逐像素一致——省掉的只是过采样。有 mip 链的图直接截链（零重采样），单级大图才重采样", en: "Textures auto-pick their resolution from \"clarity × the layer's on-screen footprint\": as long as texture resolution ≥ the layer's device-pixel footprint, output is pixel-identical to full-resolution assets — only oversampling is removed. Mip-chained textures just truncate the chain (zero resampling); single-image giants get resampled" },
          { zh: "压缩纹理（DXT1/3/5、BC7、ETC2）按文件自带的 mip 链直传给 GPU，不解成 RGBA；单通道 R8 走 GL_R8 直传。浏览器不支持对应扩展时自动回退解码路径，观感不变", en: "Compressed textures (DXT1/3/5, BC7, ETC2) upload their embedded mip chains straight to the GPU instead of decoding to RGBA; single-channel R8 uploads as GL_R8. Unsupported browsers fall back to the decode path with identical visuals" },
          { zh: "上传完成后立即释放 CPU 侧解码副本（多帧动画 .tex 除外），最坏单墙可省数百 MB", en: "CPU-side decoded copies are freed right after upload (except multi-frame animated .tex) — up to hundreds of MB on the worst wallpapers" },
          { zh: "白名单不缩：LUT 数据栅格、多帧动画、视频纹理保持原样；法线/蒙版可降但有独立下限。挂载后 window.__memStats() 给出 pkg/解码/上传的分项台账", en: "Whitelisted assets never shrink: LUT data grids, multi-frame animations and video textures stay native; normal/mask maps have their own floor. window.__memStats() after mount reports per-bucket usage (package/decoded/uploaded)" },
          { zh: "window.__memStats().bake 是**贴图烘焙的正式统计**：{ enabled, backend, hits, misses, baked, failed, bytesMB, ms }。backend 如实报缓存落在哪（cache-api = 跨页面/跨启动持久，memory = 仅本页，off = 烘焙已关）；hits/misses 是内嵌图的命中率，baked/bytesMB/ms 是首帧之后后台补烘的量与耗时。诊断文本（bake: …）与这个字段同源", en: "window.__memStats().bake is the **formal texture-bake accounting**: { enabled, backend, hits, misses, baked, failed, bytesMB, ms }. The backend field reports where the cache actually lives (cache-api = persisted across pages and launches, memory = this page only, off = baking disabled); hits/misses are the embedded-image hit rate, and baked/bytesMB/ms are the background re-bake volume and time after the first frame. The diagnostic text (bake: …) reads the same source" },
          { zh: "低内存设备的推荐组合：清晰度 0.8 + 质量 low（粒子/后处理 low、抗锯齿关）。4K 屏上画布与效果链 FBO 才是大头（随 DPR 平方增长，MSAA4 再 ×4），纹理反而是其次", en: "Recommended combo for low-memory devices: clarity 0.8 + quality low (particles/post low, anti-aliasing off). On 4K screens the canvas and effect-chain FBOs dominate — they grow with DPR squared and MSAA4 multiplies by 4 — textures come second" },
          { zh: "性能与省电：三个杠杆，数字都是本机实测（Apple M5，真 GPU 与 SwiftShader 两档）——", en: "Performance & power: three levers, all figures measured on an Apple M5 under both a real GPU and SwiftShader —" },
          { zh: "① **帧率上限**（fps: 30）：scene 壁纸稳态 CPU 降 25~38%（847 层的实时太阳系 73%→46%、效果链重的 Persona 5 场景 59%→45%），代价是 30fps 的观感；网页壁纸几乎无效（负载在壁纸自己的进程里，实测 89%→89%）", en: "(1) **fps cap** (fps: 30) — steady-state CPU on scene wallpapers drops 25-38% (the 847-layer solar system 73%→46%, the effect-chain-heavy Persona 5 scene 59%→45%) at the cost of 30fps smoothness; nearly no effect on web wallpapers (their load lives in their own process: 89%→89% measured)" },
          { zh: "② **后处理档位**（quality.postProcessing）：off 稳定省 25~40% CPU，并把掉到 43fps 的场景拉回 60。粒子档**除 off 外基本无效**（1630 live 粒子的场景：high 85.8% / medium 84.9% / off 14.2% —— medium 是安慰剂，off 会让雪/雨/火花整片消失），所以自动降档只走后处理", en: "(2) **post-processing tier** (quality.postProcessing) — off saves 25-40% CPU consistently and pulls a 43fps scene back to 60. The particle tier is **inert except at off** (1630 live particles: high 85.8% / medium 84.9% / off 14.2% — medium is a placebo, off wipes out snow/rain/sparks), which is why the automatic downgrade only touches post-processing" },
          { zh: "③ **无 GPU（软件渲染）**：后处理 off **加**画布 DPR 0.5 缺一不可 —— 单用 pp=off 是 16fps、单用 DPR 0.5 仍是 0fps、两者同时 46fps。这一对由 autoQuality 在挂载期自动套用（显式指定则不覆盖）", en: "(3) **no GPU (software rendering)** — post-processing off **plus** canvas DPR 0.5, neither alone suffices: pp=off alone gives 16fps, DPR 0.5 alone still 0fps, both together 46fps. autoQuality applies this pair at mount time (an explicit choice is never overridden)" }
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
          [{ zh: "setQuality(patch) / getQuality()", en: "setQuality(patch) / getQuality()" }, { zh: "质量档位热更（部分更新），就地生效不重挂载；换场景/load() 后保持", en: "Live quality-tier patch (partial update), applied in place with no remount; survives scene/load() changes" }],
          [{ zh: "setProperties(props)", en: "setProperties(props)" }, { zh: "属性热更新：就地改属性表/效果常量/脚本沙箱，不重新拉包", en: "Live property updates: patches the property table / effect constants / script sandboxes in place, no re-fetch" }],
          [{ zh: "getProperties()", en: "getProperties()" }, { zh: "当前生效的扁平化属性值表", en: "The current flattened property value map" }],
          [{ zh: "setAudio(src)", en: "setAudio(src)" }, { zh: "换音频频谱源（拉模式，每帧一次）；null 回落内置静默占位。换场景不清空。scene 与 web 都生效", en: "Swap the audio spectrum source (pull model, once per frame); null falls back to the built-in silent placeholder. Survives scene changes. Works for scene and web" }],
          [{ zh: "setMedia(src)", en: "setMedia(src)" }, { zh: "换系统媒体源（Now Playing）；scene 与 web 共用同一实例，换场景不清空", en: "Swap the system media source (Now Playing); shared by scene and web, survives scene changes" }],
          [{ zh: "media", en: "media" }, { zh: "媒体控制面：读 snapshot，以及 skipNext / skipPrevious / play / pause / playPause 反向控制", en: "Media control surface: read snapshot, plus skipNext / skipPrevious / play / pause / playPause transport control" }],
          [{ zh: "pushPointer(u, v, buttons?, mods?)", en: "pushPointer(u, v, buttons?, mods?)" }, { zh: "外部指针注入（u/v 为 0..1 归一化；mods 为 ctrl/shift/alt/meta 掩码）。用于窗口收不到鼠标的宿主；scene 与 web 均生效", en: "Inject pointer state (u/v normalized 0..1; mods is a ctrl/shift/alt/meta mask). For hosts whose window cannot receive the mouse; works for scene and web" }],
          [{ zh: "pointerLeave()", en: "pointerLeave()" }, { zh: "指针离开：只清按键、保留最后位置（清位置会让视差与 xray 明显抽一下）", en: "Pointer left: clears buttons but keeps the last position (dropping it makes parallax and xray visibly jump)" }],
          [{ zh: "pushWheel(dx, dy, mode?, mods?)", en: "pushWheel(dx, dy, mode?, mods?)" }, { zh: "滚轮 / 触摸板注入（仅网页壁纸）。dy 正=内容向下；Mac 触摸板双指捏合映射成 mods 的 ctrl 位", en: "Inject wheel / trackpad gestures (web wallpapers only). Positive dy scrolls content down; a macOS pinch maps to the ctrl bit in mods" }],
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
    id: "properties",
    title: { zh: "用户属性 properties", en: "User properties" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "用户属性就是 WE 里作者暴露给观众的那些设置项（颜色、开关、滑条、下拉），定义在 project.json 的 general.properties。键是属性名（作者自定的，常见形态是 schemecolor、newproperty12 这类），值必须按属性类型给对应的标量：",
          en: "User properties are the settings a wallpaper author exposes in WE (colors, toggles, sliders, dropdowns), declared under general.properties in project.json. Keys are the author's property names (typically things like schemecolor or newproperty12); values must be scalars matching the property type:",
        },
      },
      {
        k: "table",
        codeCols: [0, 2],
        head: [
          { zh: "属性类型", en: "Property type" },
          { zh: "传什么", en: "What to pass" },
          { zh: "示例", en: "Example" },
        ],
        rows: [
          [{ zh: "color", en: "color" }, { zh: "字符串 \"r g b\"，三个 0..1 浮点用空格分隔（不是 #RRGGBB，也不是 0..255）", en: "A \"r g b\" string: three 0..1 floats separated by spaces (not #RRGGBB, not 0..255)" }, { zh: "\"0.5 0.2 0.8\"", en: "\"0.5 0.2 0.8\"" }],
          [{ zh: "bool", en: "bool" }, { zh: "布尔", en: "A boolean" }, { zh: "true", en: "true" }],
          [{ zh: "slider", en: "slider" }, { zh: "数字，落在作者定义的 min/max 内", en: "A number within the author's min/max" }, { zh: "100", en: "100" }],
          [{ zh: "combo", en: "combo" }, { zh: "选项值；选项为整数时给 number（整数字符串也认）", en: "The option value; pass a number when options are integers (integer strings also work)" }, { zh: "1", en: "1" }],
          [{ zh: "textinput / file / directory", en: "textinput / file / directory" }, { zh: "字符串", en: "A string" }, { zh: "\"https://…/clock.png\"", en: "\"https://…/clock.png\"" }],
        ],
      },
      {
        k: "code",
        v: {
          zh: "// 先看这张壁纸有哪些属性、当前值是什么\nconsole.log(wp.getProperties());\n// → { schemecolor: \"0 0 0\", newproperty12: true, … }\n\n// 再按名字改（只传要改的，其余保持不动）\nwp.setProperties({ schemecolor: \"0.5 0.2 0.8\", newproperty12: false });",
          en: "// First see which properties this wallpaper has and their current values\nconsole.log(wp.getProperties());\n// → { schemecolor: \"0 0 0\", newproperty12: true, … }\n\n// Then set them by name (pass only what you change; the rest stays put)\nwp.setProperties({ schemecolor: \"0.5 0.2 0.8\", newproperty12: false });",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "属性名逐壁纸不同，没有跨壁纸通用的名字——先 getProperties() 读一遍再改，不要硬编码猜名字", en: "Property names differ per wallpaper; there is no cross-wallpaper naming convention — read getProperties() first instead of hardcoding guesses" },
          { zh: "写一个当前场景没有的名字不会报错：值会照样进属性表（换场景后可能被用上），但对当前画面无任何影响——拼错名字的症状是「调了没反应」而不是异常", en: "Writing a name the current scene doesn't declare raises no error: the value still lands in the table (a later scene may use it) but changes nothing on screen — a typo shows up as \"nothing happened\", not as an exception" },
          { zh: "setProperties() 是就地热更新：改属性表、效果常量与脚本沙箱，不重新拉包也不重新解析", en: "setProperties() patches in place — property table, effect constants and script sandboxes — with no re-fetch and no re-parse" },
          { zh: "没有 project.json 的壁纸也能跑：此时属性表为空，场景字段一律用 scene.json 里的快照值", en: "Wallpapers without a project.json still run: the property table is empty and fields fall back to the scene.json snapshot values" },
        ],
      },
    ],
  },
  {
    id: "wallpaper-types",
    title: { zh: "三类壁纸：scene / video / web", en: "Three wallpaper types: scene / video / web" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "类型不用你判断：mount() 先取 project.json，按其中的 type 分流 —— web 走 sandbox iframe，video / gif / image 走媒体路径，其余一律走场景装配。三类都用同一个 mount()、同一个 SceneInstance，pause/resume、setVolume、stats 等成员通用。",
          en: "You never branch on type yourself: mount() reads project.json first and routes on its type — web goes to a sandboxed iframe, video / gif / image take the media path, everything else goes through scene assembly. All three share one mount() and one SceneInstance; pause/resume, setVolume, stats and friends work the same way.",
        },
      },
      {
        k: "code",
        v: {
          zh: "// 同一段代码挂任意类型（记得传容器 div，见上一节）\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/3789109327\"),\n});\nconsole.log(wp.info); // { width, height, layerCount, ... }",
          en: "// One code path for any type (pass a container div — see the previous section)\nconst wp = await mount(document.querySelector(\"#wp\"), {\n  source: httpSource(\"https://cdn.example.com/wallpapers/3789109327\"),\n});\nconsole.log(wp.info); // { width, height, layerCount, ... }",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "视频壁纸的资源地址由 Source.mediaEntry() 给出；httpSource 已实现（读 project.json 的 file 字段拼 {基址}/{file}）", en: "A video wallpaper's asset URL comes from Source.mediaEntry(); httpSource implements it (reads project.json's file field and joins {base}/{file})" },
          { zh: "放任意视频/图片用 mediaSource()：mediaSource(url) 或 mediaSource(file)，按扩展名自动判类型，无需 project.json", en: "For arbitrary video/images use mediaSource(): mediaSource(url) or mediaSource(file) — the type is inferred from the extension, no project.json needed" },
          { zh: "project.type 若已显式声明则永远优先，嗅探只在它缺失时兜底——有些场景壁纸的 project.file 指向 .mp4（那是场景内的视频纹理素材，不是「这张壁纸是个视频」）", en: "An explicit project.type always wins; sniffing only fills in when it is absent — some scene wallpapers point project.file at an .mp4 (a video texture inside the scene, not \"this wallpaper is a video\")" },
          { zh: "媒体壁纸需要 WebGL2；不可用时走 onError 交给调用方决定，库不自作主张换 DOM 渲染", en: "Media wallpapers need WebGL2; when it is unavailable the failure arrives via onError for you to handle — the library does not silently switch to DOM rendering" },
          { zh: "pause/resume、setVolume、setFps、setFit 对媒体壁纸同样生效（setVolume 直接控制 <video> 的 volume 与 muted）", en: "pause/resume, setVolume, setFps and setFit all work on media wallpapers too (setVolume drives the <video> element's volume and muted directly)" },
        ],
      },
      {
        k: "code",
        v: {
          zh: "import { mount, mediaSource } from \"webwallgl\";\n\n// 远程视频：按扩展名判类型，签名 URL 的 ?query 会被正确剥掉\nawait mount(box, { source: mediaSource(\"https://cdn/clip.mp4?token=…\") });\n\n// 本地导入：拖拽或 <input type=file> 进来的视频/图片\ninput.addEventListener(\"change\", async () => {\n  const wp = await mount(box, { source: mediaSource(input.files[0]) });\n  // destroy() 时库会自动 revoke 内部创建的 objectURL\n});\n\n// 扩展名不可靠时显式指定\nmediaSource(streamUrl, { type: \"video\" });",
          en: "import { mount, mediaSource } from \"webwallgl\";\n\n// Remote video: type inferred from the extension; a signed URL's ?query is stripped correctly\nawait mount(box, { source: mediaSource(\"https://cdn/clip.mp4?token=…\") });\n\n// Local import: a video/image from drag & drop or <input type=file>\ninput.addEventListener(\"change\", async () => {\n  const wp = await mount(box, { source: mediaSource(input.files[0]) });\n  // destroy() revokes the objectURL the library created internally\n});\n\n// Specify explicitly when the extension is unreliable\nmediaSource(streamUrl, { type: \"video\" });",
        },
      },
    ],
  },
  {
    id: "now-playing",
    title: { zh: "系统媒体（Now Playing）与反向控制", en: "System media (Now Playing) & transport control" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "「正在播放」类壁纸要读歌名、歌手、进度、封面配色与歌词，部分还带上一曲/下一曲/播放暂停按钮。这些统一由一个 MediaSource 提供 —— **scene 与 web 壁纸共用同一个实例**，宿主只需维护一套 driver，两类壁纸看到同一份数据。",
          en: "\"Now Playing\" wallpapers read the title, artist, progress, cover palette and lyrics; some also have previous/next/play-pause buttons. All of it comes from a single MediaSource — **scene and web wallpapers share one instance**, so the host maintains a single driver and both wallpaper types see the same data.",
        },
      },
      {
        k: "code",
        v: {
          zh: "import { mount, createMediaSource } from \"webwallgl\";\n\n// 只给你拿得到的字段，其余（配色、歌词行、trackIndex）由库补齐\nconst media = createMediaSource(\n  { title: \"夜航星\", artist: \"相位迁移\", playing: true,\n    position: 30, duration: 212,\n    lyrics: [[0, \"第一句\"], [20, \"第二句\"]] },\n  // 反向控制：壁纸里的按钮会调到这里，你转发给真实播放器\n  { skipNext: () => player.next(),\n    playPause: () => player.toggle() },\n);\n\nconst wp = await mount(box, { source, media });\n\n// 系统 Now Playing 变化时更新（歌词行会按 position 自动重算）\nmedia.set({ title: \"下一首\", position: 0 });\n\n// 也可以挂载后再装／换／撤\nwp.setMedia(media);\nwp.setMedia(null);        // 回落「无媒体」占位\n\n// 宿主侧也能读快照与发控制指令\nconsole.log(wp.media.snapshot.title);\nwp.media.playPause();",
          en: "import { mount, createMediaSource } from \"webwallgl\";\n\n// Supply only what you have; the library fills in palette, lyric line and trackIndex\nconst media = createMediaSource(\n  { title: \"Night Star\", artist: \"Phase Shift\", playing: true,\n    position: 30, duration: 212,\n    lyrics: [[0, \"first line\"], [20, \"second line\"]] },\n  // Transport control: wallpaper buttons call these; forward them to the real player\n  { skipNext: () => player.next(),\n    playPause: () => player.toggle() },\n);\n\nconst wp = await mount(box, { source, media });\n\n// Update when the system's Now Playing changes (the lyric line re-resolves from position)\nmedia.set({ title: \"Next Track\", position: 0 });\n\n// You can also install / swap / remove it after mounting\nwp.setMedia(media);\nwp.setMedia(null);        // fall back to the \"no media\" placeholder\n\n// The host can read the snapshot and issue transport commands too\nconsole.log(wp.media.snapshot.title);\nwp.media.playPause();",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "五个配色字段必须是可链式调用的颜色对象（脚本会写 c.subtract(o).multiply(t).add(o)，给普通数组会 TypeError 熔断整个脚本）——用 createMediaSource 构造即自动满足；要手工构造时用导出的 mediaColor(r, g, b)，它接受 0..1 分量、{x,y,z} 或数组，返回带完整链式方法的对象", en: "The five palette fields must be chainable color objects (scripts write c.subtract(o).multiply(t).add(o); a plain array throws a TypeError that kills the whole script) — createMediaSource guarantees this for you; to build one by hand use the exported mediaColor(r, g, b), which accepts 0..1 components, {x,y,z} or arrays and returns an object with the full chain API" },
          { zh: "控制方法全是可选的：只提供元数据、不支持控制时，壁纸里的按钮点了静默无效，不会报错", en: "All transport methods are optional: if you only provide metadata, wallpaper buttons are silently inert rather than throwing" },
          { zh: "setMedia 换场景不清空，装一次对之后所有场景生效", en: "setMedia survives scene changes: install once and it applies to every scene loaded afterwards" },
          { zh: "视频壁纸的音频频谱会自动从 <video> 取（音条能跟着视频里的音乐动），宿主已用 setAudio 显式注入时则不接管", en: "For video wallpapers the audio spectrum is captured from the <video> automatically (visualizers react to the video's own audio); an explicit setAudio() injection takes precedence" },
        ],
      },
    ],
  },
  {
    id: "inject",
    title: { zh: "注入指针与音频", en: "Injecting pointer & audio" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "壁纸宿主常常拿不到浏览器天然的输入：桌面壁纸叠在桌面 underlay 层，鼠标与滚轮事件被系统的桌面窗口吃掉；音频频谱也得由宿主自己采集。这几条通道都由实例方法喂进来。",
          en: "A wallpaper host often cannot rely on the browser's native input: desktop wallpapers sit in the desktop underlay layer where the system's desktop window swallows mouse and wheel events, and the audio spectrum has to be captured by the host itself. These channels are fed through instance methods.",
        },
      },
      {
        k: "code",
        v: {
          zh: "// 指针：u/v 是 0..1 归一化坐标，buttons 同 MouseEvent.buttons\nwp.pushPointer(0.5, 0.5, 0);   // 悬停在正中\nwp.pushPointer(0.5, 0.5, 1);   // 按下左键\nwp.pointerLeave();             // 鼠标移出（只清按键，保留最后位置）\n\n// 滚轮 / 触摸板（仅网页壁纸）：dy 与 DOM deltaY 同向；mode 0=像素 1=行 2=页\nwp.pushWheel(0, 100, 0, 0);    // 双指向下滚一格\nwp.pushWheel(0, -50, 0, 1);    // Mac 双指捏合 = ctrl 位（mods bit0）\n\n// 音频：拉模式，渲染循环每帧调一次 snapshot()\nlet latest = { left: new Float32Array(64), right: new Float32Array(64) };\nwp.setAudio({ snapshot: () => latest });\n\n// 例：订阅宿主的频谱推送后更新 latest\nevtSource.onmessage = (e) => { latest = JSON.parse(e.data); };\n\nwp.setAudio(null);             // 撤源，回落静默占位",
          en: "// Pointer: u/v are normalized 0..1; buttons matches MouseEvent.buttons\nwp.pushPointer(0.5, 0.5, 0);   // hover at the center\nwp.pushPointer(0.5, 0.5, 1);   // press the left button\nwp.pointerLeave();             // pointer left (clears buttons, keeps last position)\n\n// Wheel / trackpad (web wallpapers only): dy matches DOM deltaY; mode 0=px 1=line 2=page\nwp.pushWheel(0, 100, 0, 0);    // two-finger scroll down one notch\nwp.pushWheel(0, -50, 0, 1);    // macOS pinch = ctrl bit (mods bit0)\n\n// Audio: pull model — the render loop calls snapshot() once per frame\nlet latest = { left: new Float32Array(64), right: new Float32Array(64) };\nwp.setAudio({ snapshot: () => latest });\n\n// e.g. update `latest` from the host's spectrum stream\nevtSource.onmessage = (e) => { latest = JSON.parse(e.data); };\n\nwp.setAudio(null);             // remove the source; audio falls silent",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "指针注入与 canvas 自身的 DOM 监听并存，谁后写谁赢；scene 与 web 壁纸都生效，媒体壁纸没有指针概念，调用静默无效", en: "Injected pointer state coexists with the canvas's own DOM listeners — last writer wins. It works for scene and web wallpapers; media wallpapers have no pointer concept, so the call is silently inert" },
          { zh: "pushWheel 只对网页壁纸生效：场景壁纸没有滚轮 API（实测 194 张场景壁纸零消费）。网页侧会同时合成现代 wheel 与旧式 mousewheel——语料里唯一真正用滚轮的 360° 全景（3406740580）只听旧式，而 three.js OrbitControls 只听现代；不发 DOMMouseScroll，否则同一滚动会被处理两遍", en: "pushWheel only affects web wallpapers: scenes have no wheel API (zero consumers across 194 scene wallpapers tested). The web side synthesizes both the modern wheel and the legacy mousewheel — the only wallpaper that genuinely uses the wheel (a 360° panorama, 3406740580) listens solely to the legacy event, while three.js OrbitControls listens solely to the modern one. DOMMouseScroll is deliberately not dispatched, or the same scroll would be processed twice" },
          { zh: "Mac 触摸板：双指滚动直接喂像素级 delta（mode=0）；双指捏合按浏览器约定映射成 ctrl+滚轮（mods bit0），OrbitControls / pano2vr 都靠它区分缩放与滚动", en: "macOS trackpad: feed two-finger scrolls as pixel deltas (mode=0); map a two-finger pinch to ctrl+wheel (mods bit0), exactly as browsers do — OrbitControls / pano2vr rely on that bit to tell zoom from scroll" },
          { zh: "音频契约：left/right 各 64 段、值域 0..1。段数不足补零、超出截断；32/16 段降采样与响度、静音判定由库派生", en: "Audio contract: 64 bands per channel, values 0..1. Short arrays are zero-padded and long ones truncated; the 32/16-band downsamples plus level and silence detection are derived by the library" },
          { zh: "snapshot() 返回 null（或抛错）表示本帧无数据，引擎自动回落内置静默占位——宿主采集还没就绪时不必特殊处理", en: "Returning null (or throwing) from snapshot() means \"no data this frame\" and the engine falls back to the built-in silent placeholder — no special handling needed while host capture is still warming up" },
          { zh: "setAudio 换场景不清空：装一次对之后 load() 的所有场景都生效", en: "setAudio survives scene changes: install it once and it applies to every scene loaded afterwards" },
          { zh: "音频注入对 scene 与 web 壁纸都生效：网页侧经 iframe shim 的音频泵收到同一份数据；两个泵都逐帧选源，所以 mount() 之后再 setAudio 同样有效", en: "Audio injection works for both scene and web wallpapers: the web side receives the same data through the iframe shim audio pump, and both pumps pick their source per frame so calling setAudio after mount() works too" },
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
          { zh: "load() 换场景会把实例恢复成播放态（即使换之前是暂停的），要保持暂停就在 load() 之后再 pause() 一次", en: "load() puts the instance back into the playing state (even if it was paused before); call pause() again after load() to stay paused" },
          { zh: "load() 会重新套用挂载时传入的 properties，此前用 setProperties() 改的值不会延续到新场景——属性名本就是逐场景定义的，要沿用得自己在 load() 之后再设一次", en: "load() re-applies the properties given at mount time; values set later via setProperties() do not carry over — property names are per-scene anyway, so re-apply them after load() if you need them" },
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
          { zh: "网页壁纸无音频/属性：入口 HTML 必须同源或 CORS 可读，库才能改写注入 WE shim；跨域不可读时会退回裸 iframe（无官方 API）。webSandbox: \"strict\" 不属此列：shim 照常注入、API 齐全，只是控制/音频/媒体走 postMessage 通道", en: "Web wallpaper has no audio/properties: the entry HTML must be same-origin or CORS-readable so the library can inject the WE shim; unreadable cross-origin falls back to a bare iframe (no official APIs). webSandbox: \"strict\" is not this case — the shim is injected and the full API works (control/audio/media travel over postMessage)" },
          { zh: "网页壁纸相对资源 404：依赖 <base href> 指回原站点目录；依赖 location.href 拼路径的壁纸在 blob 加载下可能异常", en: "Web wallpaper relative assets 404: resources rely on <base href> pointing at the original directory; wallpapers that build URLs from location.href may break under blob loading" },
        ],
      },
    ],
  },
  {
    id: "changelog",
    title: { zh: "版本更新说明", en: "Changelog" },
    blocks: [
      {
        k: "p",
        v: {
          zh: `当前版本 ${version}。这里不再维护逐版本列表：每一次变化的症状、根因、影响面数字与验证方式都写在对应的提交信息里，完整历史见 GitHub 仓库的提交记录与 Release。`,
          en: `Current version: ${version}. Per-version lists are no longer maintained here: every change records its symptom, root cause, measured scope and verification method in the corresponding commit message — see the commit history and Releases on the GitHub repository.`,
        },
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
