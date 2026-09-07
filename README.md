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
import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@1.0.0/webwallgl.min.mjs";
```

```
<!-- 3) UMD <script>：暴露全局 WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl@1.0.0/webwallgl.global.min.js"></script>
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

## 版权与合规

库代码 MIT。Wallpaper Engine 创意工坊素材（scene.pkg、贴图、音视频）版权归各自作者所有：请仅指向你自己拥有或已获授权的素材，不要把他人作品打包进你的产品或公网分发。

## 赞赏作者

如果这个渲染核心帮到了你的项目，欢迎请作者喝杯咖啡。扫描二维码即可赞赏，金额随意。

| 微信支付 | 支付宝 |
| --- | --- |
| ![微信支付赞赏码](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/wechat.png) | ![支付宝赞赏码](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/alipay.png) |
