# WebWallGL —— 浏览器端 WE 场景壁纸渲染库

**[简体中文](README.md) ｜ [English](README.en.md)**

## 简介

WebWallGL 是一个浏览器端的 Wallpaper Engine「scene」场景、视频、web 网页壁纸渲染库：主要功能是把创意工坊场景包（scene.pkg）在 WebGL 里实时还原，支持图层效果链、粒子、3D 木偶骨骼、文字挂件、脚本沙箱、音频响应与用户自定义属性热更新；网页类型壁纸经 sandbox iframe + 加载前 WE shim 注入运行。后续版本将加入本库独有效果支持，请敬请期待。

- [GitHub 开源仓库](https://github.com/oneincase/webwallgl)
- [在线版（GitHub Pages）](https://oneincase.github.io/webwallgl/)

- 零运行时依赖，单文件引入（min ESM 约 270KB / gzip 约 90KB）
- 可 npm 安装，也可 &lt;script> CDN 引入；一页可开多个互不干扰的实例
- 本测试台本身就是库的第一个使用者 —— 你在这里看到的能力都是公共 API

## 能做什么

WebWallGL 是一个「壁纸兼容渲染核心」——凡是需要「动态背景」的地方，都可以塞一个 WebWallGL 实例进去：

- 壁纸软件：桌面壁纸引擎（Tauri / Electron / WebView 壳）的核心渲染器，完整还原 WE 创意工坊场景
- 网页：个人主页、落地页、产品官网的动态背景或全屏 hero 区块
- 各类代码工具：仪表盘、监控大屏、终端（如 GUI 启动器/开发工具）的背景层
- 背景插件：音乐播放器可视化、直播 OBS 背景板、数字标牌、kye/小部件引擎的嵌入渲染源

一句话：万物皆可 Wall。你的应用只负责提供一块 canvas 和场景包的来源，剩下的解析、装配、渲染循环、脚本沙箱、指针与音频，全部交给 WebWallGL。

## 安装

三种引入方式，任选其一（CDN 示例按当前发布版本固定）：

```
// 1) npm + 打包器（推荐）
npm i webwallgl           // 追最新版；锁定测试版用 npm i webwallgl@beta
import { mount, httpSource } from "webwallgl";
```

```
// 2) ESM CDN（jsDelivr，vite/webpack 之外的直引方式）
import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@1.3.5/webwallgl.min.mjs";
```

```
<!-- 3) UMD <script>：暴露全局 WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl@1.3.5/webwallgl.global.min.js"></script>
<script>
  const { mount, httpSource } = WebWallGL;
</script>
```

## 快速开始

一个 canvas + 一个资源来源就是全部。mount() 在首帧真正画出来之后 resolve：

```
<canvas id="wp" style="width:100%;height:400px"></canvas>

import { mount, httpSource } from "webwallgl";

const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/3122339805"),
  fps: 60,
});

// 首帧之后实例即可用：
wp.pause();
wp.resume();
wp.setProperties({ schemecolor: "0.5 0.2 0.8" });
console.log("实测帧率", wp.stats.fps);
```

画布的 CSS 尺寸就是渲染尺寸：库把 backing store 对齐 clientWidth/clientHeight，容器改大小后画面宽高比自动跟随，不需要手动 resize。

## 挂载目标：canvas 还是容器 div

mount() 的第一个参数收任意 HTMLElement，不限于 canvas。传 canvas 就直接用它；传普通容器（div 等）则库在其内部自建一块铺满的 canvas（带 data-webwallgl 标记，重复挂载会复用同一块，容器若是 position:static 会被改成 relative）。

选哪个不是风格问题——**网页类型壁纸必须传容器**。网页壁纸不走 WebGL，库会把 sandbox iframe 直接 appendChild 进你传的元素；canvas 不能有子元素，传 canvas 会挂不上。如果同一段代码要同时应付场景壁纸和网页壁纸（例如一个通用壁纸播放器），一律传 div 最稳妥：

```
<!-- 通用写法：两类壁纸都能挂 -->
<div id="wp" style="position:relative;width:100%;height:400px"></div>

// 场景壁纸：库在 div 内自建 canvas
// 网页壁纸：库在 div 内挂 sandbox iframe
const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/2517518192"),
});

// wp.canvas 始终可读：场景路径是那块真 canvas，网页路径是你传入的容器
console.log(wp.canvas);
```

- 类型不用你判断：mount() 先取 project.json，type 为 "web" 走网页路径，其余一律走场景装配
- 网页入口 URL 的解析顺序是 Source.webEntry() → {httpSource 基址}/{project.file 或 index.html}；两者都给不出就抛错
- 网页路径下 fit / renderDpr / features 这些 WebGL 侧选项自然不适用；pause/resume、setVolume、setProperties 仍然有效（经 shim 转达给作者代码）

## 资源来源 Source

库对网络只发两个请求（scene.pkg 与可选的 project.json），所以资源抽象只有一个接口、三个内置实现：

| 工厂 | 用途 |
| --- | --- |
| `httpSource(baseUrl, init?)` | HTTP 基址；自动按 scene.pkg → scenes/scene.pkg → gifscene.pkg 三种真实布局回退 |
| `fileSource(file, project?)` | &lt;input type=file> 或拖拽进来的 .pkg 本地文件 |
| `bytesSource(pkg, project?, key?)` | 已经拿到字节（bundle 内嵌、IndexedDB 缓存、自定义通道） |

```
// 本地文件：拖一个 scene.pkg 进页面即可预览
input.addEventListener("change", () => {
  const src = fileSource(input.files[0]);
  mount(canvas, { source: src });
});
```

- httpSource 必须先试根目录 scene.pkg，且每个 fetch 单独容错 —— WKWebView/自定义协议对缺失路径抛 Failed to fetch 而不是 404，顺序错了会「一片壁纸全坏」
- source.key 参与库内解析缓存：相同 key 的包不会重复解析（暂停/改属性零网络）
- project 缺失是常态：没有属性表时场景字段用 scene.json 内的快照值

## 挂载选项 MountOptions

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `source（必填）` | `—` | 见上节 Source |
| `fit` | `"cover"` | cover 等比裁切铺满 / contain 等比留边 / stretch 拉伸 |
| `renderDpr` | `1` | 渲染 DPR 上限（实际取 min(devicePixelRatio, renderDpr)），调低省显存 |
| `fps` | `60` | 帧率上限；被上限跳过的帧不计入 stats.fps，掉帧一眼可见 |
| `volume` | `0` | 0..1。默认静音起步（浏览器自动播放策略）；就绪后再设非零音量 |
| `autoplay` | `true` | false 时挂载后保持暂停 |
| `properties` | `{}` | 初始用户属性覆盖值（键为属性名） |
| `pointer / audio / media` | `内置` | 指针跟随 canvas、音频/系统媒体为确定性模拟；传 null 禁用 |
| `features` | `全开` | 调试开关：models / text / particles / effects / components |
| `onReady / onError / onDiagnostic` | `—` | 回调面；也可之后用 instance.on() 订阅 |

## 实例 API SceneInstance

| 成员 | 说明 |
| --- | --- |
| `pause() / resume() / paused` | 暂停恢复。禁止整包重挂：恢复时视频/音频从暂停点继续 |
| `setFit(fit) / setFps(n) / setVolume(v)` | 热更新，无需重挂载（渲染循环每帧读取） |
| `setRenderDpr(dpr)` | 改 DPR 需重建画布，内部自动重挂（pkg 缓存命中，不重新下载） |
| `setProperties(props)` | 属性热更新：就地改属性表/效果常量/脚本沙箱，不重新拉包 |
| `getProperties()` | 当前生效的扁平化属性值表 |
| `setAudio(src)` | 换音频频谱源（拉模式，每帧一次）；null 回落内置模拟。换场景不清空。scene 与 web 都生效 |
| `setMedia(src)` | 换系统媒体源（Now Playing）；scene 与 web 共用同一实例，换场景不清空 |
| `media` | 媒体控制面：读 snapshot，以及 skipNext / skipPrevious / play / pause / playPause 反向控制 |
| `pushPointer(u, v, buttons?)` | 外部指针注入（u/v 为 0..1 归一化）。用于窗口收不到鼠标的宿主；scene 与 web 均生效 |
| `pointerLeave()` | 指针离开：只清按键、保留最后位置（清位置会让视差与 xray 明显抽一下） |
| `load(source)` | 换场景，复用同一 canvas 与 WebGL 上下文；首帧后 resolve |
| `release() / restore()` | 释放显存但保留配置（显示器睡眠）/ 用保留的配置重建 |
| `destroy()` | 终态：释放资源、解绑监听，之后实例不可再用 |
| `stats / info` | 实测帧率（{fps, running}，停了会归零而不是冻住）/ 场景基本信息（逻辑分辨率、图层数、是否含模型/粒子/文字） |
| `on(ev, fn)` | 订阅 ready / error / diagnostic，返回取消函数 |

## 用户属性 properties

用户属性就是 WE 里作者暴露给观众的那些设置项（颜色、开关、滑条、下拉），定义在 project.json 的 general.properties。键是属性名（作者自定的，常见形态是 schemecolor、newproperty12 这类），值必须按属性类型给对应的标量：

| 属性类型 | 传什么 | 示例 |
| --- | --- | --- |
| `color` | 字符串 "r g b"，三个 0..1 浮点用空格分隔（不是 #RRGGBB，也不是 0..255） | `"0.5 0.2 0.8"` |
| `bool` | 布尔 | `true` |
| `slider` | 数字，落在作者定义的 min/max 内 | `100` |
| `combo` | 选项值；选项为整数时给 number（整数字符串也认） | `1` |
| `textinput / file / directory` | 字符串 | `"https://…/clock.png"` |

```
// 先看这张壁纸有哪些属性、当前值是什么
console.log(wp.getProperties());
// → { schemecolor: "0 0 0", newproperty12: true, … }

// 再按名字改（只传要改的，其余保持不动）
wp.setProperties({ schemecolor: "0.5 0.2 0.8", newproperty12: false });
```

- 属性名逐壁纸不同，没有跨壁纸通用的名字——先 getProperties() 读一遍再改，不要硬编码猜名字
- 写一个当前场景没有的名字不会报错：值会照样进属性表（换场景后可能被用上），但对当前画面无任何影响——拼错名字的症状是「调了没反应」而不是异常
- setProperties() 是就地热更新：改属性表、效果常量与脚本沙箱，不重新拉包也不重新解析
- 没有 project.json 的壁纸也能跑：此时属性表为空，场景字段一律用 scene.json 里的快照值

## 三类壁纸：scene / video / web

类型不用你判断：mount() 先取 project.json，按其中的 type 分流 —— web 走 sandbox iframe，video / gif / image 走媒体路径，其余一律走场景装配。三类都用同一个 mount()、同一个 SceneInstance，pause/resume、setVolume、stats 等成员通用。

```
// 同一段代码挂任意类型（记得传容器 div，见上一节）
const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/3789109327"),
});
console.log(wp.info); // { width, height, layerCount, ... }
```

- 视频壁纸的资源地址由 Source.mediaEntry() 给出；httpSource 已实现（读 project.json 的 file 字段拼 {基址}/{file}）
- 放任意视频/图片用 mediaSource()：mediaSource(url) 或 mediaSource(file)，按扩展名自动判类型，无需 project.json
- project.type 若已显式声明则永远优先，嗅探只在它缺失时兜底——有些场景壁纸的 project.file 指向 .mp4（那是场景内的视频纹理素材，不是「这张壁纸是个视频」）
- 媒体壁纸需要 WebGL2；不可用时走 onError 交给调用方决定，库不自作主张换 DOM 渲染
- pause/resume、setVolume、setFps、setFit 对媒体壁纸同样生效（setVolume 直接控制 &lt;video> 的 volume 与 muted）

```
import { mount, mediaSource } from "webwallgl";

// 远程视频：按扩展名判类型，签名 URL 的 ?query 会被正确剥掉
await mount(box, { source: mediaSource("https://cdn/clip.mp4?token=…") });

// 本地导入：拖拽或 <input type=file> 进来的视频/图片
input.addEventListener("change", async () => {
  const wp = await mount(box, { source: mediaSource(input.files[0]) });
  // destroy() 时库会自动 revoke 内部创建的 objectURL
});

// 扩展名不可靠时显式指定
mediaSource(streamUrl, { type: "video" });
```

## 系统媒体（Now Playing）与反向控制

「正在播放」类壁纸要读歌名、歌手、进度、封面配色与歌词，部分还带上一曲/下一曲/播放暂停按钮。这些统一由一个 MediaSource 提供 —— **scene 与 web 壁纸共用同一个实例**，宿主只需维护一套 driver，两类壁纸看到同一份数据。

```
import { mount, createMediaSource } from "webwallgl";

// 只给你拿得到的字段，其余（配色、歌词行、trackIndex）由库补齐
const media = createMediaSource(
  { title: "夜航星", artist: "相位迁移", playing: true,
    position: 30, duration: 212,
    lyrics: [[0, "第一句"], [20, "第二句"]] },
  // 反向控制：壁纸里的按钮会调到这里，你转发给真实播放器
  { skipNext: () => player.next(),
    playPause: () => player.toggle() },
);

const wp = await mount(box, { source, media });

// 系统 Now Playing 变化时更新（歌词行会按 position 自动重算）
media.set({ title: "下一首", position: 0 });

// 也可以挂载后再装／换／撤
wp.setMedia(media);
wp.setMedia(null);        // 回落内置模拟源

// 宿主侧也能读快照与发控制指令
console.log(wp.media.snapshot.title);
wp.media.playPause();
```

- 五个配色字段必须是可链式调用的颜色对象（脚本会写 c.subtract(o).multiply(t).add(o)，给普通数组会 TypeError 熔断整个脚本）——用 createMediaSource 构造即自动满足
- 控制方法全是可选的：只提供元数据、不支持控制时，壁纸里的按钮点了静默无效，不会报错
- setMedia 换场景不清空，装一次对之后所有场景生效
- 视频壁纸的音频频谱会自动从 &lt;video> 取（音条能跟着视频里的音乐动），宿主已用 setAudio 显式注入时则不接管

## 注入指针与音频

壁纸宿主常常拿不到浏览器天然的输入：桌面壁纸叠在桌面 underlay 层，鼠标事件被系统的桌面窗口吃掉；音频频谱也得由宿主自己采集。两条通道都由实例方法喂进来。

```
// 指针：u/v 是 0..1 归一化坐标，buttons 同 MouseEvent.buttons
wp.pushPointer(0.5, 0.5, 0);   // 悬停在正中
wp.pushPointer(0.5, 0.5, 1);   // 按下左键
wp.pointerLeave();             // 鼠标移出（只清按键，保留最后位置）

// 音频：拉模式，渲染循环每帧调一次 snapshot()
let latest = { left: new Float32Array(64), right: new Float32Array(64) };
wp.setAudio({ snapshot: () => latest });

// 例：订阅宿主的频谱推送后更新 latest
evtSource.onmessage = (e) => { latest = JSON.parse(e.data); };

wp.setAudio(null);             // 撤源，回落内置模拟
```

- 指针注入与 canvas 自身的 DOM 监听并存，谁后写谁赢；scene 与 web 壁纸都生效，媒体壁纸没有指针概念，调用静默无效
- 音频契约：left/right 各 64 段、值域 0..1。段数不足补零、超出截断；32/16 段降采样与响度、静音判定由库派生
- snapshot() 返回 null（或抛错）表示本帧无数据，引擎自动回落内置模拟源——宿主采集还没就绪时不必特殊处理
- setAudio 换场景不清空：装一次对之后 load() 的所有场景都生效
- 音频注入对 scene 与 web 壁纸都生效：网页侧经 iframe shim 的音频泵收到同一份数据；两个泵都逐帧选源，所以 mount() 之后再 setAudio 同样有效

## 事件与诊断

```
const off = wp.on("diagnostic", (msg, level) => {
  // level: "info" | "warn" | "error"
  console[level === "error" ? "error" : "log"]("[wp]", msg);
});
wp.on("error", (err) => showError(err));
wp.on("ready", (info) => {
  // info: { width, height, layerCount, hasModels, hasParticles, hasText }
});
```

库不自带降级页，也不向任何服务器上报：诊断与错误全部经回调交给你，渲染失败的兜底（提示、换壁纸、卸载实例）由调用方决定。

## 一页多实例

```
const a = await mount(c1, { source: httpSource(urlA) });
const b = await mount(c2, { source: httpSource(urlB) });
b.pause(); // 不影响 a
```

- 每个实例持独立的 Runtime：配置、帧率计、WebGL 上下文、属性表互不可见
- 指针事件挂在各自的 canvas 上，归一化坐标相对画布，不会截获整页输入
- 注意 WebGL 上下文数量：浏览器一般允许同页 8~16 个，超出会丢最旧的上下文

## 生命周期与缓存

- 解析后的 scene.pkg 按 source.key 缓存（最多 2 份）：暂停恢复、改属性、setRenderDpr 重挂都不重新下载
- release() 后 stats.running 变 false、读数归零 —— 停住的读数不该冻在最后一个值上
- destroy() 之后 canvas 归还给你，库不再碰它；可以再 mount() 一个新实例
- load() 换场景会把实例恢复成播放态（即使换之前是暂停的），要保持暂停就在 load() 之后再 pause() 一次
- load() 会重新套用挂载时传入的 properties，此前用 setProperties() 改的值不会延续到新场景——属性名本就是逐场景定义的，要沿用得自己在 load() 之后再设一次

## 故障排查

- 黑屏且 onError 报 WEBGL2_UNAVAILABLE：环境没有 WebGL2，库不做软件回退
- HTTP 404 加载失败：确认 httpSource 指向的目录里真的有 scene.pkg（三种布局会依次尝试，全部失败才报错）
- Failed to fetch 且无状态码：自定义协议/WKWebView 对缺失路径的行为，属正常容错路径，看最后一条错误即可
- stats.fps 为 0 但画面在动：读数是「真正提交渲染」的帧，标签页被遮挡时浏览器会暂停 rAF，属预期
- 有声音但延迟起播：自动播放策略要求用户交互后才允许出声，volume 默认 0 正是为此
- 网页壁纸无音频/属性：入口 HTML 必须同源或 CORS 可读，库才能改写注入 WE shim；跨域不可读时会退回裸 iframe（无官方 API）
- 网页壁纸相对资源 404：依赖 &lt;base href> 指回原站点目录；依赖 location.href 拼路径的壁纸在 blob 加载下可能异常

## 版本更新说明

当前版本 1.3.5。本节只记对使用者可见的变化（API、行为、兼容性、还原度），逐条对应仓库里的提交；纯内部重构与判据脚本不列。

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| `1.3.5` | 2026-09-08 | xray 效果：作者未在场景里配置 size 时，缺省从 shader 注释的 0.2 改为 1（恒等） |
| `1.3.4` | 2026-09-08 | 补齐 1.3.3 遗留四项：setFit 对网页壁纸生效、audio:null 真静音、裸 iframe 回退不再帧数恒 0、调试全局随卸载清理 |
| `1.3.3` | 2026-09-08 | 全量审计：修 autoplay:false 挂死 mount()、scene 侧 setMedia 无效、换壁纸泄漏 AudioContext 等 |
| `1.3.2` | 2026-09-08 | 修复：「系统实况」麦克风此前只喂 scene，网页壁纸音谱仍是合成流 |
| `1.3.1` | 2026-09-08 | 修复：注入的频谱/媒体源到不了网页壁纸（音谱仍放默认流） |
| `1.3.0` | 2026-09-08 | mediaSource() 任意视频/图片；类型嗅探；媒体壁纸支持音量；scene 与 web 共用一套 Now Playing driver |
| `1.2.0` | 2026-09-08 | video 壁纸可走库入口；音频与指针注入接到公共 API（下游三项反馈） |
| `1.1.0` | 2026-09-07 | 外部指针注入通道、网页壁纸交互、效果 pass 编译清零、暂停语义补全 |
| `1.0.0` | 2026-09-06 | 首个正式版：公共 API 定稿（mount / SceneInstance / Source 三件套） |
| `1.0.0-beta1` | 2026-09-04 | 首个公开测试版 |

1.3.5 只有一项，改的是 xray 效果的缺省值。xray 的 size 决定效果范围（内部取倒数，size=1 是恒等）。作者若没在场景的 constantshadervalues 里写 size，此前会套用 shader 声明注释里的 "default":0.2 —— 但那是 WE 编辑器新建效果时滑条的初始位置，不是运行时缺省：编辑器一旦把效果加到层上就会把当时的滑条值写进场景文件，所以官方运行时永远读得到显式值。套 0.2 会让效果范围缩成五分之一，只剩光标旁一小块。现在缺省是 1。作用面收窄在这一个参数上，multiply 与贴图槽的注释缺省不变。

1.3.4 收掉 1.3.3 结尾列为「留待后续」的四项，都是能观测到的行为偏差，不是清理式重构：

- **setFit() 对网页壁纸不生效**：它只改了配置和 cover 对齐量，而网页壁纸的缩放是靠一次布局计算写进 iframe 的 transform 的，不重排就还是旧比例。现在 setFit 会触发重排（场景与媒体壁纸本来就每帧读配置，不受影响）
- **注入 shim 失败退回裸 iframe 后帧率恒 0**：这条路径不启动任何 rAF，统计里没人推进帧计数，宿主看到的是「壁纸挂了」。回退分支补上心跳 rAF，帧率与实际刷新一致
- **audio:null 在网页壁纸上不是静音，而是退回合成流**：判定只看「有没有设过注入源」，分不清「显式禁用」与「没设置」。现在两者分开，audio:null / media:null 在 scene 与 web 上都真的关掉（setAudio(src) 会重新打开）
- **调试全局不随卸载清理**：__scene / __textures 等 19 个诊断入口在 clear() 后仍挂在 window 上，指着已销毁场景的对象图，既让上一张壁纸的纹理和层树无法回收，也会让宿主在控制台里读到过期状态。改为 clear() 时逐个删除

1.3.3 是一次覆盖「漏接 / 缺陷 / 内存泄漏」三类的全量审计，修掉的都是实测确认的问题：

- **autoplay:false 会让 mount() 永久挂起**（scene 与媒体壁纸）：装配前就置 paused，渲染循环一帧都不跑，唯一触发首帧回调的地方永远到不了，Promise 既不 resolve 也不 reject。实测同一张壁纸默认能 resolve、autoplay:false 在 rAF 活跃 500 帧后仍 pending。改为照常装配、首帧画完再暂停
- 首帧回调改到 render() **完成之后**触发（此前排在 render 调用之前，早一帧落地，autoplay:false 会拿到一张空画布）
- **setMedia() 在场景壁纸上无效**：scene 把 media driver 在装配时一次性捕获，而 setMedia 通常在 mount() 之后才调用。改为每次读取重新选（web 侧本来就是这样）
- **换壁纸会泄漏 AudioContext**：视频壁纸的频谱接管把释放登记在实例级列表里，而换壁纸走的是 clear()，只有 destroy() 才排空。浏览器约 6 个 AudioContext 就到顶，之后音频响应静默失效。新增壁纸级释放列表，clear() 逐张排空
- **清理链一处抛异常会丢掉整个 teardown**：clear() 里调用装配层清理没有 try/catch，一旦抛出，后面的 WebGL 上下文释放、视频元素回收、blob revoke 全部跳过
- **麦克风授权期间换壁纸会漏掉麦克风流**：getUserMedia 阻塞在系统弹窗上，此前的释放登记写在 await 之后，这条路径上没人会调它，浏览器录音指示一直亮着。两条装配路径都改为同步登记释放槽
- instance.media 控制面在 clear() 时重置（此前 release()/destroy() 之后它仍指向已销毁场景的沙箱闭包）

已知仍未接线（有意为之，类型注释已标注）：MountOptions 的 pointer 与 features。外部喂指针请用 pushPointer()。

1.3.2 补上同一症状的**第二条通道**：1.3.1 修的是宿主注入（setAudio），而测试台「系统实况」勾选框走的是另一条路（cfg.liveSystem，库自己采麦克风），它此前只被 scene 装配路径消费——web.ts 里 liveSystem 零引用，所以勾上之后场景壁纸的音条跟着麦克风动、网页壁纸却始终是合成流。

- 网页壁纸现在也接系统实况麦克风，与 scene 用同一份采集（startLiveSystem）
- 麦克风采集是异步的（getUserMedia 要用户授权），不阻塞泵启动：先按默认源跑，授权通过后回填、由逐帧选源切过去
- 音频源优先级：宿主注入（setAudio）> 系统实况麦克风 > 内置模拟
- 卸载时释放麦克风流（否则浏览器地址栏的录音指示会一直亮着）

1.3.1 修一个下游实测发现的缺陷：**麦克风都接上了，网页壁纸的音谱还在放默认合成流**。

- 根因一：web 装配路径压根不读 rt.audioBridge（1.3.0 给媒体源接了这一环，音频这行漏了），注入的频谱到不了 iframe
- 根因二：音频与媒体两个泵都在**装配时**捕获 driver，而 setAudio()/setMedia() 通常在 mount() 之后才调用（宿主的麦克风 / SSE 通道那时才就绪）——定死 driver 等于后装的源永远不生效。两个泵均改为逐帧选源，撤源后也能落回默认
- 注入的频谱**不再套 gamma 对比扩展**：那道处理是给内置模拟源的未钳位频段用的，对宿主给的 0..1 真实频谱再乘一遍会把音条整体顶到满格

1.3.0 是 1.2.0 的直接延续，继续按下游宿主的反馈补齐（四项）：

- 新增 mediaSource(urlOrFile)：任意视频/图片可直接当壁纸，支持远程 URL 与本地 File（拖拽导入）。本地文件的 objectURL 由库在 destroy()/换源时自动 revoke——不 revoke 就是每换一次壁纸泄漏一个几十 MB 的 blob
- 类型嗅探：project.type 缺失时按 URL 扩展名判定（正确剥掉签名 URL 的 ?query 与 #hash），认不出才落回 scene。显式声明的 project.type 永远优先，不会被嗅探覆盖
- 媒体壁纸现在支持 setVolume（此前完全无效：音量只打到 scene 的音频节点）。同时写 volume 与 muted——&lt;video muted> 下只改 volume 一点用都没有；取消静音被自动播放策略拒绝时经 onDiagnostic 如实报出，不静默吞掉
- MediaSource 扩成 driver 的真实契约（18 字段快照 + 5 个可选控制方法），并由 scene 与 web **共用同一个实例**——此前两侧各自 new 一份模拟源，宿主无从注入。新增 createMediaSource() 只需给已知字段，配色/歌词行/trackIndex 由库补齐并保证颜色是可链式调用的实例
- 新增 SceneInstance.setMedia() 与 media 控制面（读快照 + 上一曲/下一曲/播放暂停），反向控制直接转发给宿主 driver；宿主更新数据后引擎同帧可见
- 视频壁纸的频谱自动从 &lt;video> 取，音条能跟着视频里的音乐动；宿主已用 setAudio 显式注入时不接管

1.2.0 补的是三个「运行时早就能跑、只是公共库入口没接出来」的缺口（由下游宿主 wallpaperEM 反馈）：

- video / gif / image 壁纸现在能经 mount() 挂载：新增 Source.mediaEntry() 取址，并补齐媒体路径的库化契约。此前媒体路径不触发 onFirstFrame / onError，即便接上分流，mount() 的 Promise 也会永久挂起——成功不 resolve、失败不 reject
- 媒体路径改为支持调用方传入的 canvas，并按 CSS 尺寸而非窗口尺寸分配缓冲区（此前嵌入式画布会拿到整窗口大小的 backing store，且画布根本不会被插入 DOM）
- MountOptions.audio 真正接线（此前是声明了却零引用的死字段），并新增 SceneInstance.setAudio() 供挂载后切换——宿主的频谱通道常在 mount() 之后才就绪
- 新增 SceneInstance.pushPointer() / pointerLeave()，与整页渲染器的 __wp 同名同签名，下游从整页迁到库时代码不用改
- 已知边界（当时状态）：音频注入只对 scene 生效——网页壁纸走 iframe shim 的另一条通道，1.3.1 已补上；媒体壁纸没有指针概念；MountOptions 的 pointer / media / features 当时未接线（media 已在 1.3.0 接线）

1.1.0 的内容（在 1.0.0 之后合入）：

- 新增外部指针注入通道 __wp.pushPointer / pointerLeave：桌面壁纸窗口收不到鼠标时（如 macOS 下 Finder 桌面窗口吃掉事件），由宿主轮询系统鼠标后推进来。场景与网页两类壁纸共用同一套协议，调用方不必判断类型
- 网页壁纸接入同一条注入通道：shim 按命中元素合成 DOM 事件（over/out/enter/leave 链完整、click 靠按键边缘合成）。本机库 49 张网页壁纸里 mousemove 24 / click 29 / pointer* 16 张的交互从「完全无反应」变为可用。硬限制：CSS :hover 由浏览器 hit-test 驱动，合成事件点不亮
- 效果 pass 编译失败清零（七批）：转译器修掉整浮混用、宏作用域、向量收窄、科学计数法等形态。全库效果 pass 编译通过率 1653/1873 (88.3%) → 1823/1873 (97.3%)，累计 +170。症状是「某个效果静默不出现」——编译失败只 warn 不报错，画面上表现为体积光/音谱/光晕整个缺失
- 暂停语义补全：暂停必须同时冻结 rAF/定时器与 CSS 动画（合成器驱动的 CSS 动画不受 JS 冻结影响，1444432396 表现为「点了暂停画面照旧」）；恢复必须重挂 rAF 挂起项（rAF 自递归的壁纸暂停一次就永久断链，1278092907 表现为「恢复后永久定格」），且只还原我们代为暂停的部分
- 还原度修复若干：关键帧动画改用真实时钟（此前按目标帧间隔累加，与骨骼两套时基必然发散，30 秒漂 5.5 秒，表现为头发与头不同步、头顶漏模）；对象脚本与关键帧动画的坐标空间改为 local 并每帧重算父子变换（此前把脚本返回的 local 值直接写进 world 槽，表现为元素无人操作就自行滑走、被边缘裁切）；clipping_mask 引用的隐藏遮罩层现在能正确回读身后画面（此前回退成引用方自身，表现为一块纯白板）
- 使用说明新增「挂载目标」与「用户属性」两节：网页壁纸必须传容器 div 而非 canvas，以及各类属性该传什么形态的值

完整提交历史见 GitHub 仓库；每条修复在提交信息里都写明了症状、根因、影响面数字与验证方式。

## 版权与合规

库代码 MIT。Wallpaper Engine 创意工坊素材（scene.pkg、贴图、音视频）版权归各自作者所有：请仅指向你自己拥有或已获授权的素材，不要把他人作品打包进你的产品或公网分发。

## 赞赏作者

如果这个渲染核心帮到了你的项目，欢迎请作者喝杯咖啡。扫描二维码即可赞赏，金额随意。

| 微信支付 | 支付宝 |
| --- | --- |
| ![微信支付赞赏码](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/wechat.png) | ![支付宝赞赏码](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/alipay.png) |
