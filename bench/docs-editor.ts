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
          zh: "编辑器按项目工作：新建时必须先选一个保存文件夹，之后松散文件（scene.json、资源）会自动保存。不直接修改壁纸库里的壁纸。导出时才选择打成 scene.pkg，或打成 zip 压缩包。",
          en: "The editor works on projects: creating one asks for a save folder first, then loose files (scene.json and assets) autosave. Library wallpapers are not edited in place. Export is when you choose a scene.pkg package or a zip archive.",
        },
      },
      {
        k: "ul",
        items: [
          { zh: "入口：预览标题栏的「编辑器」；本地开发地址为 http://localhost:1430/editor/。壁纸库条目不能直接拿来改", en: "Entry: \"Editor\" in the preview title bar; the local dev URL is http://localhost:1430/editor/. Library items are not opened for editing" },
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
          [{ zh: "主工具条（顶）", en: "Main toolbar (top)" }, { zh: "新建 / 打开项目 / 导出、撤销 / 重做、播放 / 暂停、重新加载、导出 PNG、重置布局", en: "New / Open project / Export, undo / redo, play / pause, reload, export PNG, reset layout" }],
          [{ zh: "图层（左）", en: "Layers (left)" }, { zh: "图层树，显示当前项目场景的全部对象", en: "The layer tree, listing every object in the current project" }],
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
        ],
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
          [{ zh: "⌘S", en: "⌘S" }, { zh: "立刻自动保存到项目文件夹", en: "Autosave to the project folder now" }],
          [{ zh: "⌘D", en: "⌘D" }, { zh: "复制选中图层", en: "Duplicate the selected layer" }],
          [{ zh: "Delete / Backspace", en: "Delete / Backspace" }, { zh: "删除选中图层", en: "Delete the selected layer" }],
          [{ zh: "Alt + 点击", en: "Alt + click" }, { zh: "逐层切换选中", en: "Cycle selection through stacked layers" }],
          [{ zh: "⌘Enter", en: "⌘Enter" }, { zh: "应用正在编辑的脚本", en: "Apply the script being edited" }],
        ],
      },
    ],
  },
];
