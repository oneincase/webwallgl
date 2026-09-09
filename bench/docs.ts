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
          zh: "WebWallGL 是一个浏览器端的 Wallpaper Engine「scene」场景、视频、web 网页壁纸渲染库：主要功能是把创意工坊场景包（scene.pkg）在 WebGL 里实时还原，支持图层效果链、粒子、3D 木偶骨骼、文字挂件、脚本沙箱、音频响应与用户自定义属性热更新；网页类型壁纸经 sandbox iframe + 加载前 WE shim 注入运行。后续版本将加入本库独有效果支持，请敬请期待。",
          en: "WebWallGL is a browser-side renderer for Wallpaper Engine wallpapers — scene, video, and web: its main job is replaying workshop scene packages (scene.pkg) in WebGL in real time, with layer effect chains, particles, 3D puppet bones, text widgets, script sandboxes, audio response and live user-property updates; web wallpapers run in a sandboxed iframe with a WE API shim injected before author scripts. Upcoming versions will add effects exclusive to this library — stay tuned.",
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
          { zh: "网页路径下 fit / renderDpr / features 这些 WebGL 侧选项自然不适用；pause/resume、setVolume、setProperties 仍然有效（经 shim 转达给作者代码）", en: "On the web path the WebGL-side options (fit / renderDpr / features) do not apply; pause/resume, setVolume and setProperties still work, relayed to author code through the shim" },
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
          [{ zh: "setAudio(src)", en: "setAudio(src)" }, { zh: "换音频频谱源（拉模式，每帧一次）；null 回落内置模拟。换场景不清空。scene 与 web 都生效", en: "Swap the audio spectrum source (pull model, once per frame); null falls back to the built-in sim. Survives scene changes. Works for scene and web" }],
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
          zh: "import { mount, createMediaSource } from \"webwallgl\";\n\n// 只给你拿得到的字段，其余（配色、歌词行、trackIndex）由库补齐\nconst media = createMediaSource(\n  { title: \"夜航星\", artist: \"相位迁移\", playing: true,\n    position: 30, duration: 212,\n    lyrics: [[0, \"第一句\"], [20, \"第二句\"]] },\n  // 反向控制：壁纸里的按钮会调到这里，你转发给真实播放器\n  { skipNext: () => player.next(),\n    playPause: () => player.toggle() },\n);\n\nconst wp = await mount(box, { source, media });\n\n// 系统 Now Playing 变化时更新（歌词行会按 position 自动重算）\nmedia.set({ title: \"下一首\", position: 0 });\n\n// 也可以挂载后再装／换／撤\nwp.setMedia(media);\nwp.setMedia(null);        // 回落内置模拟源\n\n// 宿主侧也能读快照与发控制指令\nconsole.log(wp.media.snapshot.title);\nwp.media.playPause();",
          en: "import { mount, createMediaSource } from \"webwallgl\";\n\n// Supply only what you have; the library fills in palette, lyric line and trackIndex\nconst media = createMediaSource(\n  { title: \"Night Star\", artist: \"Phase Shift\", playing: true,\n    position: 30, duration: 212,\n    lyrics: [[0, \"first line\"], [20, \"second line\"]] },\n  // Transport control: wallpaper buttons call these; forward them to the real player\n  { skipNext: () => player.next(),\n    playPause: () => player.toggle() },\n);\n\nconst wp = await mount(box, { source, media });\n\n// Update when the system's Now Playing changes (the lyric line re-resolves from position)\nmedia.set({ title: \"Next Track\", position: 0 });\n\n// You can also install / swap / remove it after mounting\nwp.setMedia(media);\nwp.setMedia(null);        // fall back to the built-in simulation\n\n// The host can read the snapshot and issue transport commands too\nconsole.log(wp.media.snapshot.title);\nwp.media.playPause();",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "五个配色字段必须是可链式调用的颜色对象（脚本会写 c.subtract(o).multiply(t).add(o)，给普通数组会 TypeError 熔断整个脚本）——用 createMediaSource 构造即自动满足", en: "The five palette fields must be chainable color objects (scripts write c.subtract(o).multiply(t).add(o); a plain array throws a TypeError that kills the whole script) — createMediaSource guarantees this for you" },
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
          zh: "// 指针：u/v 是 0..1 归一化坐标，buttons 同 MouseEvent.buttons\nwp.pushPointer(0.5, 0.5, 0);   // 悬停在正中\nwp.pushPointer(0.5, 0.5, 1);   // 按下左键\nwp.pointerLeave();             // 鼠标移出（只清按键，保留最后位置）\n\n// 滚轮 / 触摸板（仅网页壁纸）：dy 与 DOM deltaY 同向；mode 0=像素 1=行 2=页\nwp.pushWheel(0, 100, 0, 0);    // 双指向下滚一格\nwp.pushWheel(0, -50, 0, 1);    // Mac 双指捏合 = ctrl 位（mods bit0）\n\n// 音频：拉模式，渲染循环每帧调一次 snapshot()\nlet latest = { left: new Float32Array(64), right: new Float32Array(64) };\nwp.setAudio({ snapshot: () => latest });\n\n// 例：订阅宿主的频谱推送后更新 latest\nevtSource.onmessage = (e) => { latest = JSON.parse(e.data); };\n\nwp.setAudio(null);             // 撤源，回落内置模拟",
          en: "// Pointer: u/v are normalized 0..1; buttons matches MouseEvent.buttons\nwp.pushPointer(0.5, 0.5, 0);   // hover at the center\nwp.pushPointer(0.5, 0.5, 1);   // press the left button\nwp.pointerLeave();             // pointer left (clears buttons, keeps last position)\n\n// Wheel / trackpad (web wallpapers only): dy matches DOM deltaY; mode 0=px 1=line 2=page\nwp.pushWheel(0, 100, 0, 0);    // two-finger scroll down one notch\nwp.pushWheel(0, -50, 0, 1);    // macOS pinch = ctrl bit (mods bit0)\n\n// Audio: pull model — the render loop calls snapshot() once per frame\nlet latest = { left: new Float32Array(64), right: new Float32Array(64) };\nwp.setAudio({ snapshot: () => latest });\n\n// e.g. update `latest` from the host's spectrum stream\nevtSource.onmessage = (e) => { latest = JSON.parse(e.data); };\n\nwp.setAudio(null);             // remove the source, fall back to the built-in sim",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "指针注入与 canvas 自身的 DOM 监听并存，谁后写谁赢；scene 与 web 壁纸都生效，媒体壁纸没有指针概念，调用静默无效", en: "Injected pointer state coexists with the canvas's own DOM listeners — last writer wins. It works for scene and web wallpapers; media wallpapers have no pointer concept, so the call is silently inert" },
          { zh: "pushWheel 只对网页壁纸生效：场景壁纸没有滚轮 API（实测 194 张场景壁纸零消费）。网页侧会同时合成现代 wheel 与旧式 mousewheel——语料里唯一真正用滚轮的 360° 全景（3406740580）只听旧式，而 three.js OrbitControls 只听现代；不发 DOMMouseScroll，否则同一滚动会被处理两遍", en: "pushWheel only affects web wallpapers: scenes have no wheel API (zero consumers across 194 scene wallpapers tested). The web side synthesizes both the modern wheel and the legacy mousewheel — the only wallpaper that genuinely uses the wheel (a 360° panorama, 3406740580) listens solely to the legacy event, while three.js OrbitControls listens solely to the modern one. DOMMouseScroll is deliberately not dispatched, or the same scroll would be processed twice" },
          { zh: "Mac 触摸板：双指滚动直接喂像素级 delta（mode=0）；双指捏合按浏览器约定映射成 ctrl+滚轮（mods bit0），OrbitControls / pano2vr 都靠它区分缩放与滚动", en: "macOS trackpad: feed two-finger scrolls as pixel deltas (mode=0); map a two-finger pinch to ctrl+wheel (mods bit0), exactly as browsers do — OrbitControls / pano2vr rely on that bit to tell zoom from scroll" },
          { zh: "音频契约：left/right 各 64 段、值域 0..1。段数不足补零、超出截断；32/16 段降采样与响度、静音判定由库派生", en: "Audio contract: 64 bands per channel, values 0..1. Short arrays are zero-padded and long ones truncated; the 32/16-band downsamples plus level and silence detection are derived by the library" },
          { zh: "snapshot() 返回 null（或抛错）表示本帧无数据，引擎自动回落内置模拟源——宿主采集还没就绪时不必特殊处理", en: "Returning null (or throwing) from snapshot() means \"no data this frame\" and the engine falls back to the built-in simulation — no special handling needed while host capture is still warming up" },
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
          { zh: "网页壁纸无音频/属性：入口 HTML 必须同源或 CORS 可读，库才能改写注入 WE shim；跨域不可读时会退回裸 iframe（无官方 API）", en: "Web wallpaper has no audio/properties: the entry HTML must be same-origin or CORS-readable so the library can inject the WE shim; unreadable cross-origin falls back to a bare iframe (no official APIs)" },
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
          zh: `当前版本 ${version}。本节只记对使用者可见的变化（API、行为、兼容性、还原度），逐条对应仓库里的提交；纯内部重构与判据脚本不列。`,
          en: `Current version: ${version}. This section records only user-visible changes (API, behavior, compatibility, fidelity), each backed by a commit in the repository; pure internal refactors and verifier scripts are omitted.`,
        },
      },
      {
        k: "table",
        codeCols: [0],
        head: [
          { zh: "版本", en: "Version" },
          { zh: "日期", en: "Date" },
          { zh: "说明", en: "Notes" },
        ],
        rows: [
          [{ zh: "1.3.15", en: "1.3.15" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "视频对新增自愈看门狗：元素可能进入\"假播放\"（paused=false 但解码停摆、时间不走，无任何事件可听）导致壁纸永久冻结——渲染循环里检测可见页面上 currentTime 连续 ~500ms 不前进即 pause→play 硬重启解码；页面被遮挡时的合法节流不会误判", en: "The video pair gains a self-healing watchdog: elements can enter \"phantom playback\" (paused=false but the decoder stalls and time stops advancing, with no event to listen for), freezing the wallpaper permanently — the render loop now detects currentTime not advancing for ~500ms on a visible page and hard-restarts decode via pause→play; legitimate throttling while the page is occluded is not misjudged" }],
          [{ zh: "1.3.14", en: "1.3.14" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "循环交接第四版：硬切改快速淡出。爬行保证下层交接时已在运动，上层旧主元素（定格在末帧）以 64ms 线性淡出露出下层——元素级交接固有的 1~3 帧不精度（ended 分发、层交换合成）被融合窗口整体掩掉，不再依赖把每一环都压到零延迟", en: "Fourth pass at loop handover: the hard cut became a fast fade. Crawling keeps the layer beneath already moving while the old main (holding its last frame) fades out linearly over 64ms — the blend window masks the 1–3 frames of imprecision inherent to element-level handover (ended dispatch, layer-swap compositing) instead of requiring every stage to be zero-latency" }],
          [{ zh: "1.3.13", en: "1.3.13" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "无缝循环交接第三版「爬行」：备用在主元素最后 0.12s 以 1/8 速率实际播放（媒体管线全程 playing 态，仅前进约 1 帧），ended 触发时拨回 1x 并同步换层——速率切换是纯时钟操作，消除前两版的唤醒延迟/定格与内容跳跃", en: "Third pass at seamless-loop handover, \"crawling\": during the main video's final 0.12s the standby actually plays at 1/8 rate (its pipeline stays in the playing state while advancing only ~1 frame); on ended the rate flips back to 1x and layers swap in the same tick — a rate change is a pure clock operation, removing both the wakeup/freeze and the content jump of earlier versions" }],
          [{ zh: "1.3.12", en: "1.3.12" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "无缝循环交接再调：去掉预播（双路 4K 解码瞬时争抢 + 交接处内容跳跃两个残留卡顿源），改为末帧定格——主元素 ended 后停在末帧，唤起备用并确认其真正前进再换层；定格发生在内容切点上，观感为正常剪辑切换", en: "Loop handover refined again: pre-play removed (it caused a transient dual-4K-decode contention plus a content jump at the swap); the main video now holds its last frame on ended while the standby is started and confirmed to actually advance before layers swap — the hold lands on the content cut, reading as a normal edit" }],
          [{ zh: "1.3.11", en: "1.3.11" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "无缝循环交接改为「预播 + ended 精确交接」：备用在主元素最后几帧就开始在其下方实际播放，主元素 ended（精确到帧，非轮询）一触发即换层 —— 消除了旧方案里恢复播放的唤醒延迟与 rAF 检测滞后带来的最后 1~2 帧卡顿", en: "Seamless-loop handover reworked to \"pre-play + exact ended swap\": the standby actually starts playing underneath the main video a few frames before the end, and layers swap the instant ended fires (frame-exact, not polled) — eliminating the resume-wakeup latency and rAF detection lag behind the last 1–2 frame hitch" }],
          [{ zh: "1.3.10", en: "1.3.10" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "destroy() 新增 releasePkgCache 选项：销毁实例时连带淘汰该壁纸的 scene.pkg 解析缓存（此前切换壁纸后旧包仍留在缓存里，内存不降）", en: "destroy() gains a releasePkgCache option: destroying an instance also evicts that wallpaper's parsed scene.pkg cache (previously the old package stayed cached after switching, so memory never dropped)" }],
          [{ zh: "1.3.9", en: "1.3.9" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "新增 pushWheel 滚轮 / Mac 触摸板注入通道（仅网页壁纸）：合成 wheel + 旧式 mousewheel，双指捏合映射为 ctrl+滚轮；pushPointer 增加可选修饰键掩码", en: "New pushWheel channel for wheel / macOS trackpad injection (web wallpapers only): synthesizes wheel plus the legacy mousewheel, and maps a two-finger pinch to ctrl+wheel; pushPointer gains an optional modifier mask" }],
          [{ zh: "1.3.8", en: "1.3.8" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "视频壁纸改走 DOM 直显：4K 不再被降采样到 2048（清晰度）＋ A/B 双元素无缝循环（循环点卡顿 84ms→33ms）；场景内视频纹理层的上限也跟随渲染目标", en: "Video wallpapers now render as DOM video: 4K is no longer downsampled to 2048 (sharpness) and an A/B element pair gives seamless looping (loop-point hitch 84ms→33ms); the in-scene video texture cap now follows the render target too" }],
          [{ zh: "1.3.7", en: "1.3.7" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "修复库入口 setRenderDpr / restore 重挂后画面全黑（复用了已 loseContext 的画布）；场景壁纸支持 $mediaThumbnail 真实封面纹理", en: "Fix: the library entry's setRenderDpr / restore remount went fully black (it reused a canvas whose context had been lost); scene wallpapers now support the real cover texture via $mediaThumbnail" }],
          [{ zh: "1.3.6", en: "1.3.6" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "新增 MediaSnapshot.thumbnail：宿主可把真实专辑封面透传给网页壁纸（此前只能给取色，封面固定是渐变占位图）", en: "New MediaSnapshot.thumbnail: the host can now pass the real album cover to web wallpapers (previously only colors were available, and the cover was always a gradient placeholder)" }],
          [{ zh: "1.3.5", en: "1.3.5" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "xray 效果：作者未在场景里配置 size 时，缺省从 shader 注释的 0.2 改为 1（恒等）", en: "xray effect: when the author doesn't configure size in the scene, the fallback is now 1 (identity) instead of the shader comment's 0.2" }],
          [{ zh: "1.3.4", en: "1.3.4" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "补齐 1.3.3 遗留四项：setFit 对网页壁纸生效、audio:null 真静音、裸 iframe 回退不再帧数恒 0、调试全局随卸载清理", en: "Closes the four items deferred from 1.3.3: setFit now affects web wallpapers, audio:null truly mutes, the bare-iframe fallback no longer reports 0 fps, and debug globals are cleared on unmount" }],
          [{ zh: "1.3.3", en: "1.3.3" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "全量审计：修 autoplay:false 挂死 mount()、scene 侧 setMedia 无效、换壁纸泄漏 AudioContext 等", en: "Full audit: fixed autoplay:false hanging mount(), setMedia being inert on the scene path, AudioContext leaking on wallpaper swap, and more" }],
          [{ zh: "1.3.2", en: "1.3.2" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "修复：「系统实况」麦克风此前只喂 scene，网页壁纸音谱仍是合成流", en: "Fix: the \"live system\" microphone only fed scene wallpapers; web wallpaper visualizers still showed the synthetic stream" }],
          [{ zh: "1.3.1", en: "1.3.1" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "修复：注入的频谱/媒体源到不了网页壁纸（音谱仍放默认流）", en: "Fix: injected audio/media sources never reached web wallpapers (visualizers kept playing the default stream)" }],
          [{ zh: "1.3.0", en: "1.3.0" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "mediaSource() 任意视频/图片；类型嗅探；媒体壁纸支持音量；scene 与 web 共用一套 Now Playing driver", en: "mediaSource() for arbitrary video/images; type sniffing; volume for media wallpapers; one Now Playing driver shared by scene and web" }],
          [{ zh: "1.2.0", en: "1.2.0" }, { zh: "2026-09-08", en: "2026-09-08" }, { zh: "video 壁纸可走库入口；音频与指针注入接到公共 API（下游三项反馈）", en: "Video wallpapers work through the library entry; audio and pointer injection wired into the public API (three downstream reports)" }],
          [{ zh: "1.1.0", en: "1.1.0" }, { zh: "2026-09-07", en: "2026-09-07" }, { zh: "外部指针注入通道、网页壁纸交互、效果 pass 编译清零、暂停语义补全", en: "External pointer injection channel, web wallpaper interaction, effect-pass compile fixes, complete pause semantics" }],
          [{ zh: "1.0.0", en: "1.0.0" }, { zh: "2026-09-06", en: "2026-09-06" }, { zh: "首个正式版：公共 API 定稿（mount / SceneInstance / Source 三件套）", en: "First stable release: the public API is settled (mount / SceneInstance / Source)" }],
          [{ zh: "1.0.0-beta1", en: "1.0.0-beta1" }, { zh: "2026-09-04", en: "2026-09-04" }, { zh: "首个公开测试版", en: "First public preview" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "1.3.9 加的是滚轮注入通道。指针注入（pushPointer）一直只有位置与按键，没有滚轮 —— 桌面壁纸窗口收不到鼠标事件，自然也收不到滚轮。但这次扫了本机全部 256 张壁纸后发现范围比预想窄：194 张场景壁纸零滚轮消费（WE 的场景脚本沙箱根本没有滚轮 API，场景包里所有 scroll 字样都是纹理滚动图层效果 g_ScrollSpeed），只有网页壁纸用得上；而 52 张网页壁纸里真正消费滚轮的只有一张 360° 全景（3406740580，滚轮改视角 FOV），外加 three.js OrbitControls 默认开启的一张。麻烦的是这张全景只听旧式 mousewheel / DOMMouseScroll，不听现代 wheel，而 OrbitControls 又只听现代 wheel —— 只合成任意一种都会让另一类壁纸完全无反应，且没有任何报错。所以网页侧每次推送同时派发现代 wheel 与旧式 mousewheel（wheelDelta 与 deltaY 反号、detail 置 0）；刻意不发 DOMMouseScroll，因为三个旧式消费方每一个都把它和 mousewheel 绑到同一个处理函数上，三个都发等于同一次滚动处理两遍，FOV 一次跳两格，看起来只是「滚轮太灵敏」。Mac 触摸板的适配是重点：双指滚动直接是像素级 wheel（deltaMode=0），双指捏合则按浏览器约定翻译成 ctrl 位为真的 wheel（OrbitControls / pano2vr 都靠 event.ctrlKey 区分缩放与滚动），宿主从 NSEvent.magnify 映射时注意 scrollingDeltaY 要取反。滚轮位置沿用最后一次指针坐标。场景壁纸调用 pushWheel 静默无效，与视频等媒体壁纸同样处理。",
          en: "1.3.9 adds a wheel-injection channel. Pointer injection (pushPointer) always carried only position and buttons, never the wheel — the desktop wallpaper window receives no mouse events, and so no wheel either. But scanning all 256 local wallpapers showed a narrower scope than expected: the 194 scene wallpapers have zero wheel consumers (the WE scene script sandbox has no wheel API at all; every scroll token in a scene package is the texture-scroll layer effect g_ScrollSpeed), so only web wallpapers matter. Of the 52 web wallpapers, exactly one genuinely consumes the wheel — a 360° panorama (3406740580, where the wheel changes the field of view) — plus one wallpaper where three.js OrbitControls has zoom enabled by default. The snag is that the panorama listens only to the legacy mousewheel / DOMMouseScroll, never the modern wheel, while OrbitControls listens only to the modern wheel — synthesizing either one alone leaves the other class completely inert, with no error. So the web side now dispatches both a modern wheel and a legacy mousewheel per push (wheelDelta has the opposite sign to deltaY and detail stays 0); DOMMouseScroll is deliberately not dispatched, because each of the three legacy consumers binds it and mousewheel to the very same handler, so firing all three would process one scroll twice — the FOV jumps two steps at a time and merely looks like an over-sensitive wheel. macOS trackpad support is the point: two-finger scroll is a plain pixel wheel (deltaMode=0), while a two-finger pinch is translated, exactly as browsers do, to a wheel whose ctrl bit is set (OrbitControls / pano2vr rely on event.ctrlKey to tell zoom from scroll); when mapping from NSEvent.magnify the host must negate scrollingDeltaY. Wheel position reuses the last pointer coordinates. Calling pushWheel for a scene wallpaper is silently inert, the same treatment as video and other media wallpapers.",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.8 是一组视频壁纸的改动，起因是 4K 视频看起来发糊。原因不在任何清晰度设置，而是视频帧过去要先上传成 WebGL 纹理，那条路径有个写死的 2048 长边上限 —— 3840×2160 的源被降到 2048×1152（面积只剩 28%）再放大铺满屏幕，而 Retina 上渲染目标常见 3024 甚至 3840，等于把一张 2K 图放大给你看。现在视频类型直接用 `<video>` 显示，不再经纹理：浏览器按显示尺寸硬件解码合成，拿到原生分辨率，还省掉一个 WebGL 上下文和每帧一次全画布上传。代价是纯视频壁纸没有效果链/粒子叠加能力，它本来也用不到；「场景内含视频纹理层」的壁纸不走这条路，但那条路径的上限也一并改成了 min(硬件 MAX_TEXTURE_SIZE, 渲染目标长边, 3840) —— 上传比渲染目标更大的纹理是纯浪费，多出的像素在采样阶段就被丢掉。",
          en: "1.3.8 is a set of video-wallpaper changes, prompted by 4K video looking soft. The cause was not any sharpness setting: video frames used to be uploaded as WebGL textures, and that path had a hard-coded 2048 long-edge cap — a 3840×2160 source became 2048×1152 (28% of the area) and was then scaled back up to fill the screen, while a Retina render target is commonly 3024 or even 3840. In effect you were shown an upscaled 2K image. Video wallpapers now display through a plain `<video>` element instead: the browser decodes and composites in hardware at display size, so you get native resolution, and a WebGL context plus a full-canvas upload per frame are saved. The trade-off is that pure video wallpapers lose effect-chain/particle overlay — which they never used anyway. Wallpapers with an in-scene video texture layer don't take this path, but that path's cap was also changed to min(hardware MAX_TEXTURE_SIZE, render-target long edge, 3840): uploading a texture larger than the render target is pure waste, as the extra pixels are discarded at sampling time.",
        },
      },
      {
        k: "p",
        v: {
          zh: "同一版还接上了无缝循环。WebKit 的 `<video loop>` 在循环点会重置解码管线，缓冲再充分也躲不掉 —— 实测 3840×2160@60fps 的 12 秒素材，循环点最坏帧间隔 84ms（约卡 5 帧）。库里本来就有 A/B 双元素方案（主元素临近结尾时备用起播一两帧后暂停保温，真到结尾的 2~5 帧内交接），只是没接到视频壁纸上，而当初 DOM 路径注释里写着「放弃双元素，内存减半」。这个说法经实测是错的：备用元素平时**不赋 src**，只在结尾前 0.5s 窗口才预热，12 秒视频里重叠占比不到 5%，进程 RSS 峰值从 128MB 到 130MB，而循环点最坏间隔降到 33ms。所以它默认开启，没有开关。备用未及时就绪时自动退回原生 loop，只是回到旧表现，不会中断或黑屏。附带修掉的：`pause`/`resume`/`setVolume`/`setFit` 过去只认场景实例，对 DOM 视频静默失效；DOM 路径不上报首帧会让 `mount()` 的 Promise 永久挂起；不持续打点会让 `instance.stats` 恒报「已停」。判活刻意用 rAF 而非 requestVideoFrameCallback —— 后者在 WKWebView 里存在却从不回调（视频正常播放时 1.5 秒 0 次）。",
          en: "The same version also wires up seamless looping. WebKit's `<video loop>` resets the decode pipeline at the loop point and no amount of buffering avoids it — measured on a 12-second 3840×2160@60fps clip, the worst frame gap at the loop point was 84ms (roughly five dropped frames). The library already had an A/B element scheme (as the main element nears the end, the standby starts, plays one or two frames and pauses to stay warm, then hands over within 2–5 frames of the true end); it just wasn't wired to video wallpapers, and the DOM path's comment claimed \"dropped the pair, halves memory\". Measurement shows that claim was wrong: the standby element has **no src** most of the time and only preheats in the final 0.5s window, so on a 12-second clip the overlap is under 5% — process RSS peak went from 128MB to 130MB while the worst loop-point gap dropped to 33ms. So it is on by default with no switch. If the standby isn't ready in time it falls back to native loop, which merely restores the old behaviour rather than interrupting or blanking. Also fixed along the way: `pause`/`resume`/`setVolume`/`setFit` previously only knew about scene instances and silently did nothing for DOM video; not reporting a first frame on the DOM path left `mount()`'s promise hanging forever; and without continuous frame marking `instance.stats` always reported \"stopped\". Liveness deliberately uses rAF rather than requestVideoFrameCallback — the latter exists but never fires in WKWebView (0 callbacks in 1.5s while the video plays normally).",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.7 两项，都在「卸载后重挂」这条路上。一是库入口的 setRenderDpr 与 restore 重挂后画面全黑：清理阶段 renderer.dispose() 走的是 WEBGL_lose_context.loseContext()，而按规范同一个 canvas 之后再 getContext(\"webgl2\") 拿回的仍是那个已丢失的上下文对象（实测新旧引用相同、isContextLost() 为真），只有换一块新画布才能拿到可用上下文。整页渲染器不踩是因为它清理时把容器 innerHTML 清空、画布跟着删掉；库形态没有那层容器，画布被留下复用，于是宿主一改清晰度就黑屏，而且两个方法都不挂首帧守卫，连报错都没有。现在复用前先查上下文存活，死了就换新画布，调用方直接传 canvas（库不能替它换 DOM）时如实报错。二是场景壁纸的封面：它不像网页壁纸走脚本回调，作者是把 $mediaThumbnail / $mediaPreviousThumbnail 这两个 WE 保留纹理名直接填进层的 image / textures 槽，所以 1.3.6 加的 MediaSnapshot.thumbnail 对场景侧原本没有意义。现在快照里的封面变化会异步解码并上传成 GL 纹理（旧的顺位挪到 $mediaPreviousThumbnail），与「系统实况」原有的上传逻辑共用同一段像素代码。",
          en: "1.3.7 has two items, both on the unmount-then-remount path. First, the library entry's setRenderDpr and restore went fully black after remounting: teardown calls renderer.dispose(), which uses WEBGL_lose_context.loseContext(), and per spec a subsequent getContext(\"webgl2\") on that same canvas returns the very same lost context object (verified: identical reference, isContextLost() true) — only a fresh canvas yields a usable context. The full-page renderer never hit this because its teardown clears the container's innerHTML and the canvas goes with it; the library form has no such container, so the canvas was kept and reused, and a host merely changing the resolution got a black screen with no error at all, since neither method arms a first-frame guard. Now the context's liveness is checked before reuse and a dead canvas is replaced; when the caller passed its own canvas (the library must not swap someone else's DOM) an explicit error is reported instead. Second, scene wallpaper covers: unlike web wallpapers these don't go through a script callback — authors put the reserved WE texture names $mediaThumbnail / $mediaPreviousThumbnail straight into a layer's image / textures slot, so the MediaSnapshot.thumbnail added in 1.3.6 meant nothing to the scene path. A cover change in the snapshot is now decoded asynchronously and uploaded as a GL texture (the previous one shifts to $mediaPreviousThumbnail), sharing the same pixel-upload code as the existing \"live system\" path.",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.6 只有一项，补的是媒体快照里缺的封面通道。此前 MediaSnapshot 只有 hasThumbnail 和五个取色字段，没有图片本体：网页壁纸的 mediaThumbnailChanged 收到的 event.thumbnail 是库拿 primary/secondary 现画的 64×64 渐变块，语料里 `img.src = e.thumbnail` 那类写法能跑但显示的不是真封面。现在 MediaSnapshot 与 createMediaSource 都多一个可选的 thumbnail（data URL 或同源 URL），宿主填了就原样透传给壁纸，没填仍走渐变占位图；只给 thumbnail 不给 hasThumbnail 时后者自动为真。另外事件 diff 也把 thumbnail 纳入判定 —— 系统媒体接口普遍先给歌名再补封面，只看 hasThumbnail/trackIndex 会漏掉「同一首歌补上封面」这一次变化。场景（WebGL）壁纸在本版本里还用不上它：它们的脚本只读 hasThumbnail 与取色，图片本体要走保留纹理（见 1.3.7）。",
          en: "1.3.6 contains a single change: the missing cover channel in the media snapshot. MediaSnapshot previously carried only hasThumbnail plus the five color fields, with no image data — the event.thumbnail delivered to a web wallpaper's mediaThumbnailChanged was a 64×64 gradient the library painted from primary/secondary, so corpus code like `img.src = e.thumbnail` ran but never showed a real cover. MediaSnapshot and createMediaSource now both take an optional thumbnail (data URL or same-origin URL): when the host supplies it, it is passed through verbatim; when it doesn't, the gradient placeholder is still used. Supplying thumbnail without hasThumbnail implies the latter. The event diff also accounts for thumbnail now — system media interfaces typically deliver the track name first and the artwork a moment later, so watching only hasThumbnail/trackIndex would miss the \"same track, cover just arrived\" transition. Scene (WebGL) wallpapers can't use it in this version: their scripts read only hasThumbnail and the colors, and the image itself travels through a reserved texture (see 1.3.7).",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.5 只有一项，改的是 xray 效果的缺省值。xray 的 size 决定效果范围（内部取倒数，size=1 是恒等）。作者若没在场景的 constantshadervalues 里写 size，此前会套用 shader 声明注释里的 \"default\":0.2 —— 但那是 WE 编辑器新建效果时滑条的初始位置，不是运行时缺省：编辑器一旦把效果加到层上就会把当时的滑条值写进场景文件，所以官方运行时永远读得到显式值。套 0.2 会让效果范围缩成五分之一，只剩光标旁一小块。现在缺省是 1。作用面收窄在这一个参数上，multiply 与贴图槽的注释缺省不变。",
          en: "1.3.5 contains a single change: the xray effect's fallback value. xray's size drives the effect radius (it is inverted internally, so size=1 is identity). When the author doesn't write size into the scene's constantshadervalues, the shader declaration comment's \"default\":0.2 used to be applied — but that is the slider's initial position when the WE editor creates the effect, not a runtime fallback: as soon as the editor attaches the effect to a layer it writes the current slider value into the scene file, so the official runtime always reads an explicit value. Applying 0.2 shrank the effect radius to a fifth, leaving only a small patch around the cursor. The fallback is now 1. The change is scoped to this one parameter; the comment defaults for multiply and the texture slots are unchanged.",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.4 收掉 1.3.3 结尾列为「留待后续」的四项，都是能观测到的行为偏差，不是清理式重构：",
          en: "1.3.4 closes the four items 1.3.3 listed as deferred. All four are observable behaviour bugs, not cleanup refactors:",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "**setFit() 对网页壁纸不生效**：它只改了配置和 cover 对齐量，而网页壁纸的缩放是靠一次布局计算写进 iframe 的 transform 的，不重排就还是旧比例。现在 setFit 会触发重排（场景与媒体壁纸本来就每帧读配置，不受影响）", en: "**setFit() did nothing on web wallpapers**: it only updated the config and the cover alignment, while a web wallpaper's scaling lives in an iframe transform written by a layout pass. Without a re-layout the old ratio stayed. setFit now triggers one (scene and media wallpapers read the config every frame and were never affected)" },
          { zh: "**注入 shim 失败退回裸 iframe 后帧率恒 0**：这条路径不启动任何 rAF，统计里没人推进帧计数，宿主看到的是「壁纸挂了」。回退分支补上心跳 rAF，帧率与实际刷新一致", en: "**The bare-iframe fallback reported 0 fps forever**: when shim injection fails that path starts no rAF at all, so nothing advanced the frame counter and hosts saw what looked like a dead wallpaper. The fallback now runs a heartbeat rAF and reports the real refresh rate" },
          { zh: "**audio:null 在网页壁纸上不是静音，而是退回合成流**：判定只看「有没有设过注入源」，分不清「显式禁用」与「没设置」。现在两者分开，audio:null / media:null 在 scene 与 web 上都真的关掉（setAudio(src) 会重新打开）", en: "**audio:null fell back to the synthetic stream on web wallpapers instead of muting**: the check only asked whether an injected source existed, conflating \"explicitly disabled\" with \"never set\". The two are now distinct, and audio:null / media:null genuinely disable on both scene and web (setAudio(src) re-enables)" },
          { zh: "**调试全局不随卸载清理**：__scene / __textures 等 19 个诊断入口在 clear() 后仍挂在 window 上，指着已销毁场景的对象图，既让上一张壁纸的纹理和层树无法回收，也会让宿主在控制台里读到过期状态。改为 clear() 时逐个删除", en: "**Debug globals outlived unmount**: 19 diagnostic hooks such as __scene and __textures stayed on window after clear(), pointing at the destroyed scene's object graph. That both pinned the previous wallpaper's textures and layer tree in memory and let hosts read stale state from the console. clear() now deletes each of them" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "1.3.3 是一次覆盖「漏接 / 缺陷 / 内存泄漏」三类的全量审计，修掉的都是实测确认的问题：",
          en: "1.3.3 is a full audit covering unwired API, defects and memory leaks. Everything fixed here was confirmed by measurement:",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "**autoplay:false 会让 mount() 永久挂起**（scene 与媒体壁纸）：装配前就置 paused，渲染循环一帧都不跑，唯一触发首帧回调的地方永远到不了，Promise 既不 resolve 也不 reject。实测同一张壁纸默认能 resolve、autoplay:false 在 rAF 活跃 500 帧后仍 pending。改为照常装配、首帧画完再暂停", en: "**autoplay:false hung mount() forever** (scene and media wallpapers): pausing before assembly meant the render loop never ran a single frame, so the only first-frame trigger was unreachable and the promise neither resolved nor rejected. Measured: the same wallpaper resolved by default but was still pending after 500 live rAF frames with autoplay:false. It now assembles normally and pauses after the first frame is drawn" },
          { zh: "首帧回调改到 render() **完成之后**触发（此前排在 render 调用之前，早一帧落地，autoplay:false 会拿到一张空画布）", en: "The first-frame callback now fires after render() completes (previously it ran before the render call, landing one frame early, so autoplay:false handed back a blank canvas)" },
          { zh: "**setMedia() 在场景壁纸上无效**：scene 把 media driver 在装配时一次性捕获，而 setMedia 通常在 mount() 之后才调用。改为每次读取重新选（web 侧本来就是这样）", en: "**setMedia() was inert on scene wallpapers**: the scene captured its media driver once at assembly, while setMedia is typically called after mount(). It now re-picks on every read (the web path already did)" },
          { zh: "**换壁纸会泄漏 AudioContext**：视频壁纸的频谱接管把释放登记在实例级列表里，而换壁纸走的是 clear()，只有 destroy() 才排空。浏览器约 6 个 AudioContext 就到顶，之后音频响应静默失效。新增壁纸级释放列表，clear() 逐张排空", en: "**Swapping wallpapers leaked an AudioContext**: the video spectrum takeover registered its release on the instance-level list, but swapping goes through clear() while only destroy() drained it. Browsers cap out at roughly 6 AudioContexts, after which audio reactivity silently dies. A per-wallpaper release list is now drained by clear()" },
          { zh: "**清理链一处抛异常会丢掉整个 teardown**：clear() 里调用装配层清理没有 try/catch，一旦抛出，后面的 WebGL 上下文释放、视频元素回收、blob revoke 全部跳过", en: "**One throwing cleanup dropped the entire teardown**: clear() called the assembly-layer cleanup without try/catch, so a single exception skipped the WebGL context release, video element recycling and blob revocation that followed" },
          { zh: "**麦克风授权期间换壁纸会漏掉麦克风流**：getUserMedia 阻塞在系统弹窗上，此前的释放登记写在 await 之后，这条路径上没人会调它，浏览器录音指示一直亮着。两条装配路径都改为同步登记释放槽", en: "**Swapping wallpapers during the mic permission prompt orphaned the stream**: getUserMedia blocks on the system dialog, and the release was registered after the await, so nothing on that path ever called it and the browser's recording indicator stayed lit. Both assembly paths now register the release slot synchronously" },
          { zh: "instance.media 控制面在 clear() 时重置（此前 release()/destroy() 之后它仍指向已销毁场景的沙箱闭包）", en: "The instance.media control surface is reset by clear() (previously it still pointed at the destroyed scene's sandbox closures after release()/destroy())" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "已知仍未接线（有意为之，类型注释已标注）：MountOptions 的 pointer 与 features。外部喂指针请用 pushPointer()。",
          en: "Still unwired by design (marked in the type comments): MountOptions' pointer and features. Use pushPointer() to feed pointer state from outside.",
        },
      },
      {
        k: "p",
        v: {
          zh: "1.3.2 补上同一症状的**第二条通道**：1.3.1 修的是宿主注入（setAudio），而测试台「系统实况」勾选框走的是另一条路（cfg.liveSystem，库自己采麦克风），它此前只被 scene 装配路径消费——web.ts 里 liveSystem 零引用，所以勾上之后场景壁纸的音条跟着麦克风动、网页壁纸却始终是合成流。",
          en: "1.3.2 closes the **second channel** of the same symptom: 1.3.1 fixed host injection (setAudio), while the bench's \"live system\" checkbox takes a different path (cfg.liveSystem, where the library captures the microphone itself). That path was only consumed by the scene assembly — web.ts referenced liveSystem zero times — so ticking the box made scene visualizers follow the mic while web wallpapers stayed on the synthetic stream.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "网页壁纸现在也接系统实况麦克风，与 scene 用同一份采集（startLiveSystem）", en: "Web wallpapers now receive the live-system microphone through the same capture path as scene (startLiveSystem)" },
          { zh: "麦克风采集是异步的（getUserMedia 要用户授权），不阻塞泵启动：先按默认源跑，授权通过后回填、由逐帧选源切过去", en: "Microphone capture is asynchronous (getUserMedia needs user consent) and does not block pump startup: the default source runs first, then the mic is filled in and the per-frame source pick switches over" },
          { zh: "音频源优先级：宿主注入（setAudio）> 系统实况麦克风 > 内置模拟", en: "Audio source priority: host injection (setAudio) > live-system microphone > built-in simulation" },
          { zh: "卸载时释放麦克风流（否则浏览器地址栏的录音指示会一直亮着）", en: "The microphone stream is released on teardown (otherwise the browser's recording indicator stays lit)" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "1.3.1 修一个下游实测发现的缺陷：**麦克风都接上了，网页壁纸的音谱还在放默认合成流**。",
          en: "1.3.1 fixes a defect found downstream in real use: **the microphone was connected, yet web wallpapers kept showing the default synthetic stream**.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "根因一：web 装配路径压根不读 rt.audioBridge（1.3.0 给媒体源接了这一环，音频这行漏了），注入的频谱到不了 iframe", en: "Root cause 1: the web assembly path never read rt.audioBridge (1.3.0 wired this up for the media source but missed the audio line), so injected spectra never reached the iframe" },
          { zh: "根因二：音频与媒体两个泵都在**装配时**捕获 driver，而 setAudio()/setMedia() 通常在 mount() 之后才调用（宿主的麦克风 / SSE 通道那时才就绪）——定死 driver 等于后装的源永远不生效。两个泵均改为逐帧选源，撤源后也能落回默认", en: "Root cause 2: both the audio and media pumps captured their driver at assembly time, while setAudio()/setMedia() are typically called after mount() (that is when the host's microphone or SSE channel becomes ready) — a fixed driver means a later source never takes effect. Both pumps now pick their source per frame and fall back cleanly when the source is removed" },
          { zh: "注入的频谱**不再套 gamma 对比扩展**：那道处理是给内置模拟源的未钳位频段用的，对宿主给的 0..1 真实频谱再乘一遍会把音条整体顶到满格", en: "Injected spectra are no longer put through the gamma contrast expansion: that step exists for the built-in simulation's unclamped bands, and applying it to a host's already-normalized 0..1 spectrum would peg every bar at full scale" },
        ],
      },

      {
        k: "p",
        v: {
          zh: "1.3.0 是 1.2.0 的直接延续，继续按下游宿主的反馈补齐（四项）：",
          en: "1.3.0 continues directly from 1.2.0, closing four more items reported by the downstream host:",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "新增 mediaSource(urlOrFile)：任意视频/图片可直接当壁纸，支持远程 URL 与本地 File（拖拽导入）。本地文件的 objectURL 由库在 destroy()/换源时自动 revoke——不 revoke 就是每换一次壁纸泄漏一个几十 MB 的 blob", en: "New mediaSource(urlOrFile): any video or image can be a wallpaper, from a remote URL or a local File (drag & drop). The library revokes the objectURL on destroy()/source swap — without that, every wallpaper change would leak a multi-megabyte blob" },
          { zh: "类型嗅探：project.type 缺失时按 URL 扩展名判定（正确剥掉签名 URL 的 ?query 与 #hash），认不出才落回 scene。显式声明的 project.type 永远优先，不会被嗅探覆盖", en: "Type sniffing: with no project.type the URL extension decides (correctly stripping a signed URL's ?query and #hash), falling back to scene only when unrecognized. An explicit project.type always wins and is never overridden" },
          { zh: "媒体壁纸现在支持 setVolume（此前完全无效：音量只打到 scene 的音频节点）。同时写 volume 与 muted——<video muted> 下只改 volume 一点用都没有；取消静音被自动播放策略拒绝时经 onDiagnostic 如实报出，不静默吞掉", en: "setVolume now works on media wallpapers (previously a complete no-op — volume only reached the scene audio graph). It writes both volume and muted, since changing volume on a muted <video> does nothing; if unmuting is blocked by the autoplay policy that is reported via onDiagnostic rather than silently swallowed" },
          { zh: "MediaSource 扩成 driver 的真实契约（18 字段快照 + 5 个可选控制方法），并由 scene 与 web **共用同一个实例**——此前两侧各自 new 一份模拟源，宿主无从注入。新增 createMediaSource() 只需给已知字段，配色/歌词行/trackIndex 由库补齐并保证颜色是可链式调用的实例", en: "MediaSource was widened to the driver's real contract (an 18-field snapshot plus five optional transport methods) and is now **one shared instance across scene and web** — previously each side created its own simulation with no way for the host to inject. The new createMediaSource() takes only the fields you have and fills in palette, lyric line and trackIndex, guaranteeing chainable color instances" },
          { zh: "新增 SceneInstance.setMedia() 与 media 控制面（读快照 + 上一曲/下一曲/播放暂停），反向控制直接转发给宿主 driver；宿主更新数据后引擎同帧可见", en: "New SceneInstance.setMedia() and a media control surface (snapshot plus previous/next/play-pause); transport commands forward straight to the host driver, and host-side data updates are visible to the engine in the same frame" },
          { zh: "视频壁纸的频谱自动从 <video> 取，音条能跟着视频里的音乐动；宿主已用 setAudio 显式注入时不接管", en: "Video wallpapers capture their spectrum from the <video> itself so visualizers react to the video's own audio; an explicit setAudio() injection takes precedence" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "1.2.0 补的是三个「运行时早就能跑、只是公共库入口没接出来」的缺口（由下游宿主 wallpaperEM 反馈）：",
          en: "1.2.0 closes three gaps where the runtime capability already worked but was never exposed through the library entry (reported by the downstream host wallpaperEM):",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "video / gif / image 壁纸现在能经 mount() 挂载：新增 Source.mediaEntry() 取址，并补齐媒体路径的库化契约。此前媒体路径不触发 onFirstFrame / onError，即便接上分流，mount() 的 Promise 也会永久挂起——成功不 resolve、失败不 reject", en: "video / gif / image wallpapers can now be mounted via mount(): a new Source.mediaEntry() supplies the URL and the media path gained the library contract it lacked. Previously it fired neither onFirstFrame nor onError, so even with routing in place the mount() promise would hang forever — never resolving, never rejecting" },
          { zh: "媒体路径改为支持调用方传入的 canvas，并按 CSS 尺寸而非窗口尺寸分配缓冲区（此前嵌入式画布会拿到整窗口大小的 backing store，且画布根本不会被插入 DOM）", en: "The media path now honors a caller-supplied canvas and sizes its backing store from CSS dimensions rather than the window (previously an embedded canvas got a full-window buffer and was never inserted into the DOM at all)" },
          { zh: "MountOptions.audio 真正接线（此前是声明了却零引用的死字段），并新增 SceneInstance.setAudio() 供挂载后切换——宿主的频谱通道常在 mount() 之后才就绪", en: "MountOptions.audio is actually wired now (it was a declared-but-unreferenced dead field), plus a new SceneInstance.setAudio() for swapping after mount — host spectrum channels usually become ready only after mount()" },
          { zh: "新增 SceneInstance.pushPointer() / pointerLeave()，与整页渲染器的 __wp 同名同签名，下游从整页迁到库时代码不用改", en: "New SceneInstance.pushPointer() / pointerLeave(), matching the full-page renderer's __wp in both name and signature so downstream code needs no changes when migrating to the library" },
          { zh: "已知边界（当时状态）：音频注入只对 scene 生效——网页壁纸走 iframe shim 的另一条通道，1.3.1 已补上；媒体壁纸没有指针概念；MountOptions 的 pointer / media / features 当时未接线（media 已在 1.3.0 接线）", en: "Known boundaries at the time: audio injection was scene-only — web wallpapers use a separate iframe-shim channel, wired up in 1.3.1; media wallpapers have no pointer concept; MountOptions' pointer / media / features were unwired (media landed in 1.3.0)" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "1.1.0 的内容（在 1.0.0 之后合入）：",
          en: "What went into 1.1.0 (merged after 1.0.0):",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "新增外部指针注入通道 __wp.pushPointer / pointerLeave：桌面壁纸窗口收不到鼠标时（如 macOS 下 Finder 桌面窗口吃掉事件），由宿主轮询系统鼠标后推进来。场景与网页两类壁纸共用同一套协议，调用方不必判断类型", en: "New external pointer injection channel (__wp.pushPointer / pointerLeave): when the wallpaper window cannot receive the mouse (e.g. the Finder desktop window swallows events on macOS), the host polls the system cursor and pushes it in. Scene and web wallpapers share one protocol — callers need not branch on type" },
          { zh: "网页壁纸接入同一条注入通道：shim 按命中元素合成 DOM 事件（over/out/enter/leave 链完整、click 靠按键边缘合成）。本机库 49 张网页壁纸里 mousemove 24 / click 29 / pointer* 16 张的交互从「完全无反应」变为可用。硬限制：CSS :hover 由浏览器 hit-test 驱动，合成事件点不亮", en: "Web wallpapers joined the same channel: the shim synthesizes DOM events against the hit element (full over/out/enter/leave chains, click derived from button edges). Of 49 local web wallpapers, interaction went from dead to working on 24 with mousemove, 29 with click and 16 with pointer events. Hard limit: CSS :hover is driven by browser hit-testing and cannot be lit by synthetic events" },
          { zh: "效果 pass 编译失败清零（七批）：转译器修掉整浮混用、宏作用域、向量收窄、科学计数法等形态。全库效果 pass 编译通过率 1653/1873 (88.3%) → 1823/1873 (97.3%)，累计 +170。症状是「某个效果静默不出现」——编译失败只 warn 不报错，画面上表现为体积光/音谱/光晕整个缺失", en: "Effect-pass compile failures driven to near zero (seven rounds): the transpiler now handles int/float mixing, macro scoping, vector narrowing, scientific notation and more. Library-wide effect-pass compilation went from 1653/1873 (88.3%) to 1823/1873 (97.3%), +170 in total. The symptom was an effect silently missing — a failed compile only warns, so god rays / visualizers / glows simply vanished" },
          { zh: "暂停语义补全：暂停必须同时冻结 rAF/定时器与 CSS 动画（合成器驱动的 CSS 动画不受 JS 冻结影响，1444432396 表现为「点了暂停画面照旧」）；恢复必须重挂 rAF 挂起项（rAF 自递归的壁纸暂停一次就永久断链，1278092907 表现为「恢复后永久定格」），且只还原我们代为暂停的部分", en: "Pause semantics completed: pausing must freeze rAF/timers and CSS animations together (compositor-driven CSS animations ignore JS freezing — 1444432396 kept animating after pause); resuming must re-arm held rAF callbacks (self-recursive rAF wallpapers break their chain permanently — 1278092907 froze forever after resume), restoring only what we paused" },
          { zh: "还原度修复若干：关键帧动画改用真实时钟（此前按目标帧间隔累加，与骨骼两套时基必然发散，30 秒漂 5.5 秒，表现为头发与头不同步、头顶漏模）；对象脚本与关键帧动画的坐标空间改为 local 并每帧重算父子变换（此前把脚本返回的 local 值直接写进 world 槽，表现为元素无人操作就自行滑走、被边缘裁切）；clipping_mask 引用的隐藏遮罩层现在能正确回读身后画面（此前回退成引用方自身，表现为一块纯白板）", en: "Fidelity fixes: keyframe animations now run on the real clock (previously they accumulated the target frame interval, diverging from the bone clock by 5.5s over 30s — hair desynced from the head and the scalp showed through); object scripts and keyframe animations now work in local space with per-frame parent/child recomposition (previously local return values were written straight into world slots, so elements drifted away untouched and got clipped); hidden mask layers referenced by clipping_mask now correctly read back what is behind them (previously they fell back to the referencing layer itself, painting a solid white block)" },
          { zh: "使用说明新增「挂载目标」与「用户属性」两节：网页壁纸必须传容器 div 而非 canvas，以及各类属性该传什么形态的值", en: "Two new documentation sections, \"Mount target\" and \"User properties\": web wallpapers require a container div rather than a canvas, and what value shape each property type expects" },
        ],
      },
      {
        k: "p",
        v: {
          zh: "完整提交历史见 GitHub 仓库；每条修复在提交信息里都写明了症状、根因、影响面数字与验证方式。",
          en: "The full commit history lives in the GitHub repository; every fix records its symptom, root cause, measured scope and verification method in the commit message.",
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
