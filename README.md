# WebWallGL

[简体中文](#简体中文) · [English](#english)

---

## 简体中文

WebWallGL 是一个用 WebGL2 在浏览器里播放 Wallpaper Engine 壁纸的渲染核心：给它一块 canvas（或容器）和壁纸资源的来源，解析、装配、渲染循环、脚本沙箱、指针与音频都由它负责。

**特性**

- 场景壁纸（scene.pkg / 松散工程目录）、网页壁纸、视频壁纸三类都能播放
- 还原图层、效果、粒子、模型、SceneScript 脚本、用户属性与音频可视化
- 可嵌入桌面壁纸软件（Tauri / Electron / WebView）、网页背景、仪表盘、OBS 背景板等任意需要动态背景的地方
- 附带预览（壁纸播放器）与场景壁纸编辑器，可新建项目并导出官方 Wallpaper Engine 能直接加载的 scene.pkg

**安装**

```bash
pnpm add webwallgl   # 或 npm i webwallgl
```

也可以不经打包器，直接走 CDN：

```html
<script type="module">
  import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl/webwallgl.min.mjs";
</script>
<!-- 或 UMD，暴露全局 WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl/webwallgl.global.min.js"></script>
```

**快速开始**

```html
<div id="wp" style="position:relative;width:100%;height:400px"></div>
<script type="module">
  import { mount, httpSource } from "webwallgl";

  const wp = await mount(document.querySelector("#wp"), {
    source: httpSource("https://cdn.example.com/wallpapers/3122339805"),
  });
  wp.setProperties({ schemecolor: "0.5 0.2 0.8" });
</script>
```

**使用说明**

完整文档在工作台里：运行 `pnpm install && pnpm dev`，打开 <http://localhost:1430/>（会转到 <http://localhost:1430/editor/>），点标题栏的「?」或中栏的「使用说明」标签，可以在「播放库」（库 API、壁纸播放）和「编辑器」两份说明之间切换。播放与编辑在同一个页面：左栏「壁纸库」点条目即播放，并可直接编辑。

**场景编辑器**

播放与编辑在同一个工作台里：左栏「壁纸库」点一下就播放，同时可以直接改。改动先留在内存里，按 ⌘S 另存为项目文件夹后自动保存（壁纸库里的原文件永远不改），导出时再打成官方 Wallpaper Engine 能直接加载的 scene.pkg。

- 新建与打开：新建空白或以图片为背景的项目；打开项目文件夹，或把 scene.pkg 解成松散工程再编辑；图片、视频、音频直接拖进画面就成为图层
- 图层：图片、文字（文字 / 时钟 / 日期）、粒子（雪、雨、火花、光点）、视频（不是 H.264 的自动转码）、声音、模型；画面上点选、拖动、缩放、旋转，Alt + 点击在叠在一起的图层间切换；图层树里成组、拖动调整父子关系、显示 / 锁定、就地改名；全部操作可撤销
- 模型与动画：导入 glTF / GLB / FBX / OBJ / DAE / STL / PLY / 3DS，带骨骼的转成可动画的 puppet、否则转成网格；骨骼姿势编辑、动画片段增删与帧事件、图层关键帧动画；还能把一张图片变成会摆动的网格
- 效果：颜色叠加、色彩调整、暗角、模糊、波浪、滚动、呼吸，以及插件提供的效果；参数面板按参数表自动生成，支持多 pass + FBO；外来壁纸自带的效果也能识别并调整
- 逻辑：用户属性（滑条、颜色、开关、下拉、文本）可绑到图层的可见、不透明度、亮度、缩放、颜色、文本上；给图层字段挂 SceneScript 脚本，边写边检查语法和入口函数
- 检视器分为属性 / 动画 / 模型 / 效果 / 逻辑 / 信息几个标签，只显示跟当前图层有关的；支持多选批量修改
- 预览：播放 / 暂停、逐帧、拖动时间轴、倍速，可切换宽高比、适配方式、渲染 DPR，可看实时帧率曲线
- 导出：scene.pkg（贴图自动转为 .tex）、松散工程 zip、创意工坊上传用的目录、逐帧渲染的 mp4 视频、当前帧 PNG。导出前会用引擎自己的解析器把产物再读一遍做兼容性检查，有问题先写进控制台并让你确认

**万物即插件**

编辑器本体只是一个很小的内核加页面装配。效果、shader 片段、粒子模板、模型导入、图层类型、检视器面板与标签、木偶工具、导出目标 / 钩子 / 检查规则、命令与快捷键、工具条按钮，**全部是插件贡献的**。内置功能本身也是插件，和你装的外部插件走同一套装配、权限和生命周期，所以外部插件能做的事和内置功能一样多。

这个设计落在几条规则上：

- 页面只渲染注册表：检视器、导出菜单、粒子菜单、模型导入的文件类型都按注册表的当前内容生成，插件加进去的东西直接出现在界面上，不需要改页面代码
- 能替换任何内置能力：同名服务以后提供的为准，撤下后回落到前一个；注册项同 id 也是后加的优先。想换掉内置的某个导入器或导出目标，再提供一次就行
- 装得上也卸得干净：插件经内核做的一切（提供服务、注册贡献、监听事件、定时器）都记在它自己名下，停用或卸载时按相反顺序全部撤销；贡献先整体校验再登记，任何一项不合法整包回滚，不会留下半个插件
- 依赖自动管理：插件声明需要哪些服务，全部就绪才启动；依赖消失就自动撤下，恢复后自动重新启动
- 崩溃隔离：插件出错只记进控制台并归因到它；连续出错 5 次自动停用，不影响编辑器本身
- 产物始终兼容 Wallpaper Engine：插件效果引用的 shader 片段在写进工程时内联展开，粒子只允许引擎认识的组件，导出前还会用引擎自己的解析器回读检查。不管装了什么插件，导出的都是官方能直接加载的工程

插件分两种。**数据插件**只有一个文件夹和根目录的 `wwgl-plugin.json` 清单，加上效果描述 JSON、shader 片段、粒子模板、中英文词条，不运行任何代码；**代码插件**多一个单文件 ESM 入口，用 `@webwallgl/plugin-sdk` 的 `definePlugin` 编写，必须在清单里声明要用的权限，安装时会列出来让你确认。只能往注册表里加东西的权限是低风险的；能改文档、读写工程文件、改写导出产物的权限是高风险的，安装时单独警示。权限能防止误用和越权调用，但它不是沙箱，只安装来源可信的插件。

```json
{
  "id": "fx-crt",
  "name": { "zh-CN": "CRT 显像管效果", "en": "CRT monitor effect" },
  "version": "1.0.0",
  "engine": "^1.0",
  "contributes": {
    "effects": ["effects/crt.json"],
    "shaders": ["glsl/crt.glsl"]
  }
}
```

插件有三种来源：随应用自带的示例；在「插件」管理里选文件夹安装（存进浏览器本地存储）；放进 `~/.webwallgl/plugins/` 插件目录（或环境变量 `WWGL_PLUGIN_DIRS` 指向的目录），文件改动约 1.5 秒内自动热重载，适合开发。仓库的 `examples/plugins` 有七个示例可以直接当模板：

| 示例 | 类型 | 演示内容 |
| --- | --- | --- |
| `fx-crt` | 数据 | CRT 显像管效果：效果描述 + shader 片段 include，参数面板自动生成 |
| `fx-glow` | 数据 | 多 pass 柔光辉光：提取高光 → 半分辨率模糊 → 叠回原图 |
| `particle-fireflies` | 数据 | 萤火虫粒子模板 |
| `import-ply-pointcloud` | 代码 | 给已有扩展名再加一个导入器，按文件内容嗅探接管没有面的点云 PLY |
| `export-lint-strict` | 代码 | 自定义导出检查规则，阈值存在插件私有设置里 |
| `inspector-layer-stats` | 代码 | 给检视器加一个「统计」标签 |
| `cmd-layer-align` | 代码 | 带快捷键的命令 + 工具条按钮，经可撤销的文档编辑接口改图层 |

清单字段、全部扩展点、权限列表和代码插件的写法，见工作台「使用说明」里的「插件」说明。

**桌面应用**

不想装开发环境的话，工作台也有现成的桌面版：

- 安装包：在 [GitHub Releases](https://github.com/oneincase/webwallgl/releases) 下载 macOS（dmg）、Windows（安装器 / 免安装版）、Linux（AppImage / deb）版本。安装包没有签名：macOS 首次打开需右键「打开」，Windows 需在 SmartScreen 里点「仍要运行」
- 命令行：`npx webwallgl-app` 打开桌面窗口；`npx webwallgl-app --web` 只起本地服务，用浏览器打开 <http://127.0.0.1:1431/editor/>。`--library <目录>` 指定壁纸库，`--help` 查看全部选项

从源码打包：`pnpm run build:app` 组装 `app/`，`pnpm run dist:desktop` 打当前平台的安装包到 `release/`。

**版权与合规**

库代码采用 MIT 许可。Wallpaper Engine 创意工坊素材（scene.pkg、贴图、音视频）的版权归各自作者：请只使用你自己拥有或已获授权的素材，不要把他人作品打包进你的产品或在公网分发。

---

## English

WebWallGL is a WebGL2 rendering core that plays Wallpaper Engine wallpapers in the browser. Give it a canvas (or a container) and a source for the wallpaper assets; parsing, assembly, the render loop, script sandboxes, pointer input and audio are all handled for you.

**Features**

- Plays scene wallpapers (scene.pkg or a loose project folder), web wallpapers and video wallpapers
- Reproduces layers, effects, particles, models, SceneScript, user properties and audio visualization
- Embeds anywhere a dynamic background is needed: desktop wallpaper apps (Tauri / Electron / WebView), website backgrounds, dashboards, OBS backdrops and more
- Ships with a bench (wallpaper player) and a scene editor that creates, edits and exports scene.pkg files the official Wallpaper Engine loads directly

**Install**

```bash
pnpm add webwallgl   # or npm i webwallgl
```

Or skip the bundler and use a CDN:

```html
<script type="module">
  import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl/webwallgl.min.mjs";
</script>
<!-- or UMD, exposing the global WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl/webwallgl.global.min.js"></script>
```

**Quick start**

```html
<div id="wp" style="position:relative;width:100%;height:400px"></div>
<script type="module">
  import { mount, httpSource } from "webwallgl";

  const wp = await mount(document.querySelector("#wp"), {
    source: httpSource("https://cdn.example.com/wallpapers/3122339805"),
  });
  wp.setProperties({ schemecolor: "0.5 0.2 0.8" });
</script>
```

**Documentation**

The full guide lives in the workbench: run `pnpm install && pnpm dev`, open <http://localhost:1430/> (it redirects to <http://localhost:1430/editor/>), then click "?" in the title bar or the "User guide" tab in the center panel to switch between the "Player library" guide (library API and playback) and the "Editor" guide. Playing and editing share one page: click an item in the Library tab to play it and edit it right away.

**Scene editor**

Playing and editing share one workbench: click an item in the Library tab to play it and edit it right away. Changes stay in memory until ⌘S saves them as a project folder, after which they autosave (library files are never modified); export packs the result into a scene.pkg the official Wallpaper Engine loads directly.

- Create and open: start a blank project or one with an image background; open a project folder, or unpack a scene.pkg into a loose project; drop images, videos or audio onto the viewport to turn them into layers
- Layers: image, text (text / clock / date), particles (snow, rain, embers, bokeh), video (non-H.264 is transcoded automatically), sound and models; pick, move, scale and rotate on the canvas, Alt + click to cycle through stacked layers; group, re-parent by dragging, toggle visibility / lock and rename in place in the layer tree; everything is undoable
- Models and animation: import glTF / GLB / FBX / OBJ / DAE / STL / PLY / 3DS — rigged models become animatable puppets, others become meshes; edit bone poses, add / remove animation clips and frame events, keyframe layers; or turn an image into a swaying mesh
- Effects: tint, color adjust, vignette, blur, wave, scroll, pulse and plugin-provided effects; parameter panels are generated from the param table, with multi-pass + FBO support; effects shipped with third-party wallpapers are recognized and adjustable too
- Logic: bind user properties (slider, color, bool, combo, text) to a layer's visibility, opacity, brightness, scale, color or text; attach SceneScript to layer fields, with syntax and entry-point checks as you type
- The inspector is split into Properties / Animation / Model / Effects / Logic / Info tabs and only shows the ones that apply to the selected layer; multi-selection edits work too
- Preview: play / pause, frame stepping, scrubbing and speed; switch aspect ratio, fit and render DPR; watch a live frame-rate graph
- Export: scene.pkg (textures converted to .tex), a zip of the loose project, a Workshop upload folder, a frame-by-frame rendered mp4, or a PNG of the current frame. Before exporting, the output is re-read with the engine's own parsers as a compatibility check; problems go to the console and you confirm before continuing

**Everything is a plugin**

The editor itself is just a small kernel plus page wiring. Effects, shader snippets, particle templates, model importers, layer kinds, inspector panels and tabs, puppet tools, export targets / hooks / rules, commands and shortcuts, and toolbar buttons are **all contributed by plugins**. Built-in features are plugins too: they share the same wiring, permissions and lifecycle as the external plugins you install, so an external plugin can do as much as a built-in one.

The design comes down to a few rules:

- The page only renders registries: the inspector, the export menu, the particle menu and the accepted model file types are all built from the current registry contents, so whatever a plugin adds shows up in the UI without touching page code
- Any built-in can be replaced: the last provider of a service wins, and removing it falls back to the previous one; registry entries with the same id also favor the latest. To swap out a built-in importer or export target, just provide another one
- Clean install and uninstall: everything a plugin does through the kernel (services, contributions, event listeners, timers) is tracked under that plugin and undone in reverse order when it is disabled or uninstalled; contributions are all validated before registering, and if any is invalid the whole package rolls back, so there are no half-loaded plugins
- Automatic dependencies: a plugin declares the services it needs and starts once they are all ready; if one disappears the plugin is withdrawn automatically and restarted when it returns
- Crash isolation: plugin errors are logged to the console and attributed to that plugin; after 5 consecutive failures it is disabled automatically without affecting the editor
- Output always works in Wallpaper Engine: shader snippets referenced by plugin effects are inlined when written to the project, particles may only use components the engine understands, and export re-reads the result with the engine's own parsers. Whatever plugins you install, the export is a project the official app loads directly

There are two kinds of plugins. A **data plugin** is just a folder with a `wwgl-plugin.json` manifest at its root plus effect description JSON, shader snippets, particle templates and zh / en strings; it runs no code. A **code plugin** adds a single-file ESM entry written with `definePlugin` from `@webwallgl/plugin-sdk`, and must declare the permissions it uses in the manifest; they are listed for you to confirm on install. Permissions that only add registry entries are low risk; those that can modify the document, read / write project files or rewrite exports are high risk and flagged separately. Permissions stop misuse and out-of-scope calls, but they are not a sandbox — only install plugins from sources you trust.

```json
{
  "id": "fx-crt",
  "name": { "zh-CN": "CRT 显像管效果", "en": "CRT monitor effect" },
  "version": "1.0.0",
  "engine": "^1.0",
  "contributes": {
    "effects": ["effects/crt.json"],
    "shaders": ["glsl/crt.glsl"]
  }
}
```

Plugins come from three places: bundled examples that ship with the app; folders installed from the Plugins manager (stored in browser storage); and the plugin folder `~/.webwallgl/plugins/` (or folders in the `WWGL_PLUGIN_DIRS` environment variable), which hot-reloads within about 1.5 seconds of a file change — handy for development. `examples/plugins` in the repository has seven examples you can copy as templates:

| Example | Kind | Shows |
| --- | --- | --- |
| `fx-crt` | Data | CRT monitor effect: effect description + shader snippet include, with an auto-generated parameter panel |
| `fx-glow` | Data | Multi-pass soft glow: extract highlights → half-resolution blur → add back |
| `particle-fireflies` | Data | A firefly particle template |
| `import-ply-pointcloud` | Code | A second importer for an existing extension that sniffs file contents to take over face-less point-cloud PLY files |
| `export-lint-strict` | Code | A custom export check rule with thresholds in the plugin's private settings |
| `inspector-layer-stats` | Code | Adds a "Stats" tab to the inspector |
| `cmd-layer-align` | Code | Commands with shortcuts plus toolbar buttons that edit layers through the undoable document API |

For manifest fields, every extension point, the permission list and how to write code plugins, see the "Plugins" guide under "User guide" in the workbench.

**Desktop app**

The workbench also ships as a ready-to-run desktop app:

- Installers: download macOS (dmg), Windows (installer / portable) and Linux (AppImage / deb) builds from [GitHub Releases](https://github.com/oneincase/webwallgl/releases). They are unsigned: on macOS right-click and choose "Open" the first time; on Windows click "Run anyway" in SmartScreen
- Command line: `npx webwallgl-app` opens the desktop window; `npx webwallgl-app --web` only starts the local server and opens <http://127.0.0.1:1431/editor/> in your browser. Use `--library <dir>` to set the wallpaper library and `--help` for all options

Build from source: `pnpm run build:app` assembles `app/`, and `pnpm run dist:desktop` builds installers for the current platform into `release/`.

**License and compliance**

The library code is MIT-licensed. Wallpaper Engine workshop assets (scene.pkg, textures, audio and video) belong to their respective authors: only use assets you own or are licensed to use, and don't bundle other people's work into your product or redistribute it publicly.

---

## 赞赏作者 · Sponsor

如果这个项目帮到了你，欢迎请作者喝杯咖啡。 · If this project helps you, consider buying the author a coffee.

| 微信支付 · WeChat Pay | 支付宝 · Alipay |
| --- | --- |
| ![WeChat Pay](https://cdn.jsdelivr.net/gh/oneincase/webwallgl@main/public/imgs/wechat.png) | ![Alipay](https://cdn.jsdelivr.net/gh/oneincase/webwallgl@main/public/imgs/alipay.png) |
