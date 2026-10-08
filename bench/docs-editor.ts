// 编辑器使用说明：播放与编辑融合的工作台（/editor/）的界面与操作。
// 结构化双语内容；功能有变化时同步这里与 editor/i18n.ts 的界面文案。

import type { DocSection } from "./docs";

export const EDITOR_DOC: DocSection[] = [
  {
    id: "ed-intro",
    title: { zh: "编辑器简介", en: "About the editor" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "播放与编辑是同一个工作台：左侧「壁纸库」点一下就播放，同时可以直接改；改动只在内存里，按 ⌘S 选一个文件夹另存为项目后才落盘（壁纸库里的原文件永远不改）。新建或打开项目文件夹时，松散文件（scene.json、资源）会自动保存。导出时才选择打成 scene.pkg，或打成 zip 压缩包。",
          en: "Playing and editing share one workbench: click an item in the Library tab to play it and edit it right away. Changes stay in memory until ⌘S saves them as a project in a folder you pick (library files are never modified). New projects and opened project folders autosave loose files (scene.json and assets). Export is when you choose a scene.pkg package or a zip archive.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "入口：根地址会转到工作台；本地开发地址为 http://localhost:1430/editor/，?item=<itemId> 直接打开库里的某个壁纸", en: "Entry: the root URL redirects to the workbench; the local dev URL is http://localhost:1430/editor/, and ?item=<itemId> opens that library wallpaper directly" },
          { zh: "可编辑的只有场景（Scene）壁纸；网页与视频壁纸可以播放、调「壁纸配置」，但不能另存为项目", en: "Only scene wallpapers are editable; web and video wallpapers can be played and configured, but not saved as projects" },
          { zh: "快捷键里的 ⌘ 在 Windows / Linux 上对应 Ctrl", en: "⌘ in shortcuts means Ctrl on Windows / Linux" },
        ],
      },
    ],
  },
  {
    id: "ed-layout",
    title: { zh: "界面布局", en: "Layout" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "区域", en: "Area" },
          { zh: "用途", en: "What it does" },
        ],
        rows: [
          [{ zh: "主工具条（顶）", en: "Main toolbar (top)" }, { zh: "新建 / 打开 .pkg / 打开项目 / 导出、撤销 / 重做、播放 / 暂停、重新加载、导出 PNG、插件、重置布局；右上角是赞赏、使用说明（?）、主题与语言", en: "New / Open .pkg / Open project / Export, undo / redo, play / pause, reload, export PNG, plugins, reset layout; sponsor, guide (?), theme and language sit at the top right" }],
          [{ zh: "图层 | 壁纸库（左）", en: "Layers | Library (left)" }, { zh: "图层树显示当前场景的全部对象；壁纸库按 Scene / Web / Video 过滤，点条目即播放并打开编辑，右键可新窗口播放、打开所在文件夹或删除", en: "The layer tree lists every object in the current scene; the library filters by Scene / Web / Video — click an item to play and edit it, right-click to play in a new window, reveal its folder or delete it" }],
          [{ zh: "视口 | 使用说明（中）", en: "Viewport | Guide (center)" }, { zh: "视口工具条切宽高比、适配方式与渲染 DPR；时间轴负责回到开头、逐帧、拖动定位和倍速。「使用说明」就是本页", en: "The viewport bar switches aspect ratio, fit and render DPR; the timeline handles rewind, frame stepping, scrubbing and speed. \"Guide\" is this page" }],
          [{ zh: "检视器 | 壁纸配置 | 渲染（右）", en: "Inspector | Wallpaper config | Render (right)" }, { zh: "检视器：不选图层时显示工程信息与用户属性，选中图层后按「属性 / 动画 / 模型 / 效果 / 逻辑 / 信息」分标签显示（见下方「检视器」）。壁纸配置：库条目的自定义属性（只记在本机，场景即时生效）。渲染：帧率上限、音量、抗锯齿 / 粒子 / 后处理档位（全局）", en: "Inspector: project info and user properties with nothing selected; a selected layer is split into Properties / Animation / Model / Effects / Logic / Info tabs (see \"Inspector\" below). Wallpaper config: a library item's custom properties (stored on this machine, live for scenes). Render: FPS cap, volume, anti-aliasing / particle / post-processing levels (global)" }],
          [{ zh: "控制台 | 性能（底）", en: "Console | Performance (bottom)" }, { zh: "控制台记录打开、保存、编辑操作与渲染器诊断；性能是实测帧率曲线（虚线为帧率上限）", en: "The console logs opening, saving, edits and renderer diagnostics; Performance plots the measured frame rate (the dashed line is the FPS cap)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "各面板可拖动分隔条调整尺寸、双击分隔条收起，尺寸会被记住；工具条最右的「重置布局」恢复默认。",
          en: "Drag the splitters to resize panels and double-click one to collapse it; sizes are remembered. \"Reset layout\" at the right end of the toolbar restores the defaults.",
        },
      },
    ],
  },
  {
    id: "ed-open",
    title: { zh: "新建与打开", en: "Creating and opening" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "从壁纸库打开：左侧「壁纸库」标签点条目即播放，可直接编辑；状态栏提示「⌘S 另存为项目」，存过之后就和普通项目一样自动保存", en: "Open from the library: click an item in the Library tab to play it and edit it directly; the status bar shows \"⌘S to save as project\", after which it autosaves like any project" },
          { zh: "新建：先弹出文件夹选择，选定项目保存位置，再选分辨率和「空白」或「以图片为背景」", en: "New: pick the project folder first, then a resolution and \"Blank\" or \"Image background\"" },
          { zh: "打开项目：选择已有项目文件夹，之后的改动自动写回这里的松散文件", en: "Open project: pick an existing project folder; later edits autosave loose files back into it" },
          { zh: "打开 .pkg：选 scene.pkg 后还要选一个新的项目文件夹，内容解开成松散文件再编辑", en: "Open .pkg: after picking a scene.pkg you also pick a new project folder; the package is unpacked to loose files" },
          { zh: "拖入图片：已打开项目则加为图片层；还没有项目时会先选保存文件夹再新建", en: "Drop images: they become layers when a project is open; otherwise you pick a save folder and start a new project" },
          { zh: "自动保存：改动后约半秒写回项目文件夹（scene.json、资源、封面），⌘S 立刻再写一次", en: "Autosave: edits are written back to the project folder after about half a second (scene.json, assets, cover). ⌘S writes immediately" },
          { zh: "壁纸自带的脚本默认被拦截（画面停在脚本初始值），确认来源可信后可点「仍然执行」，仅对本次打开有效", en: "Scripts bundled with a wallpaper are blocked by default (the canvas stays at their initial values); click \"Run anyway\" once you trust the source — it applies to this session only" },
        ],
      },
    ],
  },
  {
    id: "ed-canvas",
    title: { zh: "画面操作与图层", en: "Canvas and layers" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "操作", en: "Action" },
          { zh: "效果", en: "Result" },
        ],
        rows: [
          [{ zh: "点击画面", en: "Click the canvas" }, { zh: "选中该处最上层的可见图层", en: "Selects the topmost visible layer under the cursor" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "在同一位置叠在一起的图层间逐层切换", en: "Cycles through layers stacked at that point" }],
          [{ zh: "拖动图层", en: "Drag a layer" }, { zh: "移动位置", en: "Moves it" }],
          [{ zh: "拖动角点", en: "Drag a corner" }, { zh: "缩放；按住 ⇧ 等比", en: "Scales it; hold ⇧ to keep proportions" }],
          [{ zh: "拖动顶部圆柄", en: "Drag the top handle" }, { zh: "旋转；按住 ⇧ 吸附 15°", en: "Rotates it; hold ⇧ to snap to 15°" }],
        ],
      },
      {
        k: "ul",
        items: [
          { zh: "图层树：眼睛图标切换可见性，锁形图标锁定（锁定后不参与点选与拖动，也不能编辑）", en: "Layer tree: the eye icon toggles visibility; the lock icon locks a layer (locked layers can't be picked, dragged or edited)" },
          { zh: "图层工具（图层标签下的工具行）：添加图片 / 文字（文字、时钟、日期）/ 粒子（雪、雨、火花、光点）/ 视频 / 声音层，导入模型，前移 / 后移一层，成组，复制（⌘D），删除（Delete）", en: "Layer tools (the toolbar row under the Layers tab): add image / text (text, clock, date) / particle (snow, rain, embers, bokeh) / video / sound layers, import a model, move up / down, group, duplicate (⌘D), delete (Delete)" },
          { zh: "拖入文件：图片、视频（mp4 / mov / webm，不是 H.264 的自动转码）、音频（mp3 / ogg / wav / flac）直接拖进画面即可新建对应图层", en: "Drop files: images, videos (mp4 / mov / webm; non-H.264 is transcoded automatically) and audio (mp3 / ogg / wav / flac) dropped onto the viewport become layers" },
          { zh: "导入模型：支持 .glb / .gltf / .fbx / .obj / .dae / .stl / .ply / .3ds，外部 .bin / .mtl / 贴图一起选上；带骨骼的转成可动画的 puppet，否则转成网格", en: "Import model: .glb / .gltf / .fbx / .obj / .dae / .stl / .ply / .3ds — select external .bin / .mtl / textures together; rigged models become animatable puppets, others become meshes" },
          { zh: "成组：新建空组把选中层放进去，画面不变；图层也可以在树里直接拖进 / 拖出其他层", en: "Group: wraps the selected layer in a new empty group without changing the picture; layers can also be dragged into / out of other layers in the tree" },
          { zh: "前移 = 更早绘制，会被后面的层盖住；后移 = 更晚绘制，盖在前面的层之上", en: "Move up = drawn earlier, so later layers cover it; move down = drawn later, on top of earlier layers" },
          { zh: "透视相机场景暂不支持画面拾取，请在图层树里选择", en: "Scenes with a perspective camera can't be picked on the canvas yet; select layers in the tree instead" },
        ],
      },
    ],
  },
  {
    id: "ed-inspector",
    title: { zh: "检视器", en: "Inspector" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "选中图层后，检视器按功能分成多个标签，只显示与该图层相关的标签（例如模型标签只在模型层出现）；最后停留的标签会被记住。不选图层时显示工程信息与用户属性。",
          en: "With a layer selected, the inspector is split into tabs by function and only shows the tabs that apply (the Model tab, for example, only appears for model layers); the last tab you used is remembered. With nothing selected it shows project info and user properties.",
        },
      },
      {
        k: "table",
        head: [
          { zh: "标签", en: "Tab" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "属性", en: "Properties" }, { zh: "变换与外观：位置、缩放、旋转（以度显示）、尺寸、不透明度、颜色、可见，改动当帧生效并写回文档（变换绑了脚本或动画的层会被覆盖）；文字 / 粒子 / 声音 / 视频层各自的参数；附着到父层或骨骼。多选时可批量改", en: "Transform & appearance: position, scale, rotation (in degrees), size, opacity, color and visibility — applied on the next frame and written to the document (layers driven by a script or animation get overridden); the specific settings of text / particle / sound / video layers; attaching to a parent layer or bone. Works on multi-selection too" }],
          [{ zh: "动画", en: "Animation" }, { zh: "图层关键帧动画；模型层的动画层与动画片段（增删、改元数据、帧事件）", en: "Layer keyframe animation; for models, animation layers and clips (add / remove, metadata, frame events)" }],
          [{ zh: "模型", en: "Model" }, { zh: "模型信息、材质贴图替换、骨骼列表与姿势编辑（视口里可直接点选骨骼）", en: "Model info, material texture replacement, bone list and pose editing (bones can be picked in the viewport)" }],
          [{ zh: "效果", en: "Effects" }, { zh: "可添加颜色叠加、色彩调整、暗角、模糊、波浪、滚动、呼吸以及插件提供的效果；每个效果可启停、调整先后顺序或移除。壁纸自带的外部效果参数只读", en: "Add tint, color adjust, vignette, blur, wave, scroll, pulse or plugin-provided effects; each can be toggled, reordered or removed. Parameters of external effects shipped with the wallpaper are read-only" }],
          [{ zh: "逻辑", en: "Logic" }, { zh: "属性绑定：把用户属性绑到图层的可见、不透明度、亮度、缩放、颜色或文本上。脚本：给图层字段挂 SceneScript，实时检查语法和入口（update / init 等），Tab 缩进，⌘Enter 应用，移除后字段回到快照值", en: "Property bindings: bind user properties to a layer's visibility, opacity, brightness, scale, color or text. Scripts: attach a SceneScript to a layer field — syntax and entry points (update / init, …) are checked as you type; Tab indents, ⌘Enter applies, and removing it restores the snapshot value" }],
          [{ zh: "信息", en: "Info" }, { zh: "只读：字段一览与当前对象在 scene.json 中的原始 JSON，便于核对", en: "Read-only: a field overview and the object's raw JSON in scene.json, for reference" }],
          [{ zh: "用户属性（不选图层时）", en: "User properties (nothing selected)" }, { zh: "场景级声明，类型有滑条、颜色、开关、下拉、文本；可设显示名、默认值、范围（最小 最大 步长）或选项（每行「值=标签」）", en: "Declared at scene level. Types: slider, color, bool, combo and text; set the display name, default value, range (min max step) or options (one \"value=label\" per line)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "右栏另外两个标签：「壁纸配置」调壁纸库条目的自定义属性（只记在本机，场景壁纸即时生效，网页 / 视频壁纸会重新加载；勾「显示条件隐藏项」可看到被条件隐藏的项）；「渲染」是全局的帧率上限、音量、抗锯齿 / 粒子 / 后处理档位，改动即时生效、不写进工程。",
          en: "The other two right-hand tabs: \"Wallpaper config\" edits a library item's custom properties (stored on this machine, live for scenes, web / video wallpapers reload; tick \"Show hidden\" to see condition-hidden entries); \"Render\" holds the global FPS cap, volume and anti-aliasing / particle / post-processing levels, applied instantly and never written into the project.",
        },
      },
    ],
  },
  {
    id: "ed-playback",
    title: { zh: "预览与导出", en: "Preview and export" },
    blocks: [
      {
        k: "ul",
        items: [
          { zh: "播放 / 暂停、重新加载（按当前文档重新挂载场景）", en: "Play / pause, and reload (remounts the scene from the current document)" },
          { zh: "时间轴：回到开头、上一帧 / 下一帧、拖动定位、倍速；暂停后逐帧检查动画最方便", en: "Timeline: rewind, previous / next frame, scrub and speed; pausing and stepping frames is the easiest way to inspect animation" },
          { zh: "视口：宽高比（可选填满视口）、适配方式（裁切填满 / 完整显示 / 拉伸）、渲染 DPR", en: "Viewport: aspect ratio (or fill the viewport), fit (cover / contain / stretch) and render DPR" },
          { zh: "导出 PNG：按场景分辨率导出当前帧", en: "Export PNG: saves the current frame at the scene's resolution" },
        ],
      },
    ],
  },
  {
    id: "ed-save",
    title: { zh: "自动保存与导出", en: "Autosave and export" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "动作", en: "Action" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "自动保存", en: "Autosave" }, { zh: "改动写入项目文件夹里的松散文件，不写进壁纸库", en: "Edits go to loose files in the project folder, not into the wallpaper library" }],
          [{ zh: "打包导出 scene.pkg", en: "Export scene.pkg" }, { zh: "下载一个 zip：project.json、封面和 scene.pkg（图片贴图转为 .tex），官方 Wallpaper Engine 可直接加载", en: "Downloads a zip of project.json, the cover and scene.pkg (image textures become .tex) that the official Wallpaper Engine loads" }],
          [{ zh: "压缩包导出 .zip", en: "Export .zip" }, { zh: "下载松散工程的 zip 压缩包", en: "Downloads a zip of the loose project" }],
          [{ zh: "导出到文件夹", en: "Export to folder" }, { zh: "写成创意工坊上传用的目录结构", en: "Writes the folder layout used for Workshop uploads" }],
          [{ zh: "录制为视频 .mp4", en: "Record as video .mp4" }, { zh: "按设定的分辨率、帧率、时长逐帧渲染后编码（不丢帧，比实时慢，不含声音）", en: "Renders frame by frame at the chosen resolution, frame rate and duration, then encodes (no dropped frames, slower than real time, no audio)" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "导出前会做 Wallpaper Engine 兼容性检查，发现错误时详情写进控制台并先确认是否仍要导出；插件也可以追加导出目标和检查项。",
          en: "Export first runs a Wallpaper Engine compatibility check; errors are written to the console and you're asked whether to export anyway. Plugins can add export targets and checks.",
        },
      },
      {
        k: "p",
        v: {
          zh: "导出不会改项目文件夹里的松散文件。状态栏显示保存中 / 已保存 / 未保存。⌘S 立刻把当前文档再写一次。",
          en: "Export does not replace the loose files in the project folder. The status bar shows Saving / Saved / Unsaved. ⌘S writes the current document immediately.",
        },
      },
    ],
  },
  {
    id: "ed-plugins",
    title: { zh: "插件", en: "Plugins" },
    blocks: [
      {
        k: "p",
        v: {
          zh: "主工具条的「插件」打开插件管理。插件可以添加效果、粒子模板、shader 片段、导入格式、导出目标和检视器面板；内置功能本身也是插件。",
          en: "\"Plugins\" in the main toolbar opens the plugin manager. Plugins can add effects, particle templates, shader snippets, import formats, export targets and inspector panels; the built-in features are plugins too.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "安装：点「安装插件文件夹…」选一个含 wwgl-plugin.json 的文件夹，或把插件放进 ~/.webwallgl/plugins 后点「重新扫描」", en: "Install: click \"Install plugin folder…\" and pick a folder containing wwgl-plugin.json, or put the plugin in ~/.webwallgl/plugins and click \"Rescan\"" },
          { zh: "权限：安装前会列出插件申请的能力；代码插件只能使用清单里申请且你已授予的能力，能改文档或工程文件的能力会单独提示", en: "Permissions: the capabilities a plugin requests are listed before install; code plugins can only use what they declare and you grant, and capabilities that can modify documents or project files are flagged" },
          { zh: "管理：每个插件可启用 / 停用、重载、卸载；出错信息写进控制台", en: "Manage: enable / disable, reload or uninstall each plugin; errors are written to the console" },
          { zh: "示例插件在仓库的 examples/plugins 目录（CRT 效果、萤火虫粒子、PLY 点云导入、严格导出检查）", en: "Example plugins live in examples/plugins in the repository (CRT effect, firefly particles, PLY point-cloud import, strict export lint)" },
        ],
      },
    ],
  },
  {
    id: "ed-keys",
    title: { zh: "快捷键", en: "Shortcuts" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "按键", en: "Keys" },
          { zh: "作用", en: "Action" },
        ],
        codeCols: [0],
        rows: [
          [{ zh: "⌘Z", en: "⌘Z" }, { zh: "撤销", en: "Undo" }],
          [{ zh: "⇧⌘Z / ⌘Y", en: "⇧⌘Z / ⌘Y" }, { zh: "重做", en: "Redo" }],
          [{ zh: "⌘S", en: "⌘S" }, { zh: "立刻保存到项目文件夹；从壁纸库打开的壁纸则另存为项目", en: "Save to the project folder now; for a wallpaper opened from the library, save it as a project" }],
          [{ zh: "⌘D", en: "⌘D" }, { zh: "复制选中图层", en: "Duplicate the selected layer" }],
          [{ zh: "Delete / Backspace", en: "Delete / Backspace" }, { zh: "删除选中图层", en: "Delete the selected layer" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "逐层切换选中", en: "Cycle selection through stacked layers" }],
          [{ zh: "⌘Enter", en: "⌘Enter" }, { zh: "应用正在编辑的脚本", en: "Apply the script being edited" }],
        ],
      },
    ],
  },
];
