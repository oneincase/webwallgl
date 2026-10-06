// 编辑器使用说明：场景壁纸编辑器（/editor/）的界面与操作。
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
          zh: "编辑器用来新建或修改 Wallpaper Engine 场景壁纸：在画面上直接拖动图层，在检视器里改变换、效果、脚本与用户属性，改动当帧生效；完成后可存回壁纸库、存到文件夹，或打成官方 Wallpaper Engine 能直接加载的 scene.pkg。",
          en: "The editor creates and modifies Wallpaper Engine scene wallpapers: drag layers right on the canvas, edit transforms, effects, scripts and user properties in the inspector, and see every change on the next frame. When done, save back to the library, to a folder, or as a scene.pkg that the official Wallpaper Engine loads directly.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "入口：测试台标题栏的「编辑器」、文件菜单「在编辑器中打开」（⌘E），或壁纸库条目右键菜单；本地开发地址为 http://localhost:1430/editor/", en: "Entry points: \"Editor\" in the bench title bar, File → Open in editor (⌘E), or the right-click menu of a library item; the local dev URL is http://localhost:1430/editor/" },
          { zh: "可编辑的只有场景（Scene）壁纸；网页与视频壁纸会以只读方式预览", en: "Only scene wallpapers are editable; web and video wallpapers open as read-only previews" },
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
          [{ zh: "主工具条（顶）", en: "Main toolbar (top)" }, { zh: "新建 / 打开 / 保存、撤销 / 重做、播放 / 暂停、重新加载、导出 PNG、重置布局", en: "New / Open / Save, undo / redo, play / pause, reload, export PNG, reset layout" }],
          [{ zh: "壁纸库 + 图层（左）", en: "Library + Layers (left)" }, { zh: "上半是壁纸库，点选即打开；下半是图层树，显示当前场景的全部对象", en: "The top half is the library — click to open; the bottom half is the layer tree listing every object in the scene" }],
          [{ zh: "视口 + 时间轴（中）", en: "Viewport + Timeline (center)" }, { zh: "视口工具条切宽高比、适配方式与渲染 DPR；时间轴负责回到开头、逐帧、拖动定位和倍速", en: "The viewport bar switches aspect ratio, fit and render DPR; the timeline handles rewind, frame stepping, scrubbing and speed" }],
          [{ zh: "检视器（右）", en: "Inspector (right)" }, { zh: "不选图层时显示工程信息与用户属性；选中图层后显示变换与外观、效果、脚本、属性绑定和原始 JSON", en: "With nothing selected it shows project info and user properties; with a layer selected it shows transform & appearance, effects, scripts, property bindings and raw JSON" }],
          [{ zh: "控制台（底）", en: "Console (bottom)" }, { zh: "打开、保存、编辑操作与渲染器诊断的日志", en: "Logs for opening, saving, edits and renderer diagnostics" }],
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
          { zh: "新建：从模板创建场景 —— 先选分辨率（含 1080 × 1920 竖屏）和背景色，再选「空白（纯色背景）」或「以图片为背景…」", en: "New: create a scene from a template — choose a resolution (including 1080 × 1920 portrait) and a background color, then pick \"Blank (solid color)\" or \"Image background…\"" },
          { zh: "打开 .pkg：选本地 scene.pkg，可同时选上 project.json 以带上标题和属性", en: "Open .pkg: pick a local scene.pkg; select its project.json too to bring along the title and properties" },
          { zh: "打开文件夹：松散工程目录（project.json + scene.json + 资源）或含 scene.pkg 的壁纸目录", en: "Open folder: a loose project folder (project.json + scene.json + assets) or a wallpaper folder containing scene.pkg" },
          { zh: "拖入：把 scene.pkg、壁纸目录或图片直接拖进视口；拖入图片时，未打开场景则以它为背景新建，已打开则添加为图片层", en: "Drag in: drop a scene.pkg, a wallpaper folder or images onto the viewport. Images start a new scene with that background when nothing is open, or become image layers otherwise" },
          { zh: "草稿：编辑中的内容会自动存为草稿，意外关闭后再次进入会提示「恢复 / 丢弃」", en: "Drafts: work in progress is autosaved; after an unexpected close you'll be offered Restore / Discard on the next visit" },
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
          { zh: "图层工具：添加图片层、前移 / 后移一层、复制（⌘D）、删除（Delete）", en: "Layer tools: add image layer, move up / down, duplicate (⌘D), delete (Delete)" },
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
        k: "table",
        head: [
          { zh: "分组", en: "Section" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "变换与外观", en: "Transform & appearance" }, { zh: "位置、缩放、旋转（以度显示）、尺寸、不透明度、颜色、可见。改动当帧生效并写回文档；变换绑了脚本或动画的层会被脚本覆盖", en: "Position, scale, rotation (in degrees), size, opacity, color and visibility. Changes apply on the next frame and are written to the document; layers whose transform is driven by a script or animation will be overridden by it" }],
          [{ zh: "效果", en: "Effects" }, { zh: "可添加颜色叠加、色彩调整、暗角、模糊、波浪、滚动、呼吸；每个效果可启停、调整先后顺序或移除。壁纸自带的外部效果参数只读", en: "Add tint, color adjust, vignette, blur, wave, scroll or pulse; each can be toggled, reordered or removed. Parameters of external effects shipped with the wallpaper are read-only" }],
          [{ zh: "脚本", en: "Scripts" }, { zh: "给图层字段挂 SceneScript。编辑时实时检查语法和入口（update / init 等），Tab 缩进，⌘Enter 应用；移除脚本后字段回到快照值", en: "Attach a SceneScript to a layer field. Syntax and entry points (update / init, …) are checked as you type; Tab indents and ⌘Enter applies. Removing a script restores the field's snapshot value" }],
          [{ zh: "用户属性", en: "User properties" }, { zh: "不选图层时在场景级声明，类型有滑条、颜色、开关、下拉、文本；可设显示名、默认值、范围（最小 最大 步长）或选项（每行「值=标签」）", en: "Declared at scene level (with no layer selected). Types: slider, color, bool, combo and text; set the display name, default value, range (min max step) or options (one \"value=label\" per line)" }],
          [{ zh: "属性绑定", en: "Property bindings" }, { zh: "选中图层后把用户属性绑到它的可见、不透明度、亮度、缩放、颜色或文本上，播放器里调属性即可驱动图层", en: "With a layer selected, bind user properties to its visibility, opacity, brightness, scale, color or text so the player's property controls drive the layer" }],
          [{ zh: "原始 JSON", en: "Raw JSON" }, { zh: "当前对象在 scene.json 中的文档值，便于核对", en: "The object's document value in scene.json, for reference" }],
        ],
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
    title: { zh: "保存", en: "Saving" },
    blocks: [
      {
        k: "table",
        head: [
          { zh: "目标", en: "Target" },
          { zh: "说明", en: "Details" },
        ],
        rows: [
          [{ zh: "另存到壁纸库", en: "Save to library" }, { zh: "写入本机壁纸库（需本地后端），保存后测试台即可直接播放", en: "Writes into the local library (needs the local backend); the bench can play it right away" }],
          [{ zh: "保存到文件夹…", en: "Save to folder…" }, { zh: "写到你选的目录（需浏览器支持目录读写）", en: "Writes into a folder you choose (needs browser directory access)" }],
          [{ zh: "下载 .zip", en: "Download .zip" }, { zh: "打包整个工程下载", en: "Downloads the whole project as an archive" }],
          [{ zh: "WE 原生格式（scene.pkg）", en: "WE native format (scene.pkg)" }, { zh: "勾选后按 scene.pkg 输出，图片贴图转为 .tex，官方 Wallpaper Engine 可直接加载；不勾选则输出松散工程", en: "When checked, output is a scene.pkg with image textures converted to .tex, loadable by the official Wallpaper Engine; otherwise a loose project is written" }],
        ],
      },
      {
        k: "p",
        v: {
          zh: "保存时会自动生成封面图。⌘S 重复上一次的保存目标；有未保存的修改时状态栏会提示。",
          en: "A preview image is generated on save. ⌘S repeats the last save target; the status bar shows when there are unsaved changes.",
        },
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
          [{ zh: "⌘S", en: "⌘S" }, { zh: "按上次的目标保存", en: "Save to the last target" }],
          [{ zh: "⌘D", en: "⌘D" }, { zh: "复制选中图层", en: "Duplicate the selected layer" }],
          [{ zh: "Delete / Backspace", en: "Delete / Backspace" }, { zh: "删除选中图层", en: "Delete the selected layer" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "逐层切换选中", en: "Cycle selection through stacked layers" }],
          [{ zh: "⌘Enter", en: "⌘Enter" }, { zh: "应用正在编辑的脚本", en: "Apply the script being edited" }],
        ],
      },
    ],
  },
];
