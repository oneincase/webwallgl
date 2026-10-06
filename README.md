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

完整文档在预览里：运行 `pnpm install && pnpm dev`，打开 <http://localhost:1430/>，进入「使用说明」标签页，可以在「播放库」（库 API、预览）和「编辑器」两份说明之间切换。编辑器地址是 <http://localhost:1430/editor/>。

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

The full guide lives in the bench: run `pnpm install && pnpm dev`, open <http://localhost:1430/> and go to the "User guide" tab, where you can switch between the "Player library" guide (library API and the bench) and the "Editor" guide. The editor itself is at <http://localhost:1430/editor/>.

**License and compliance**

The library code is MIT-licensed. Wallpaper Engine workshop assets (scene.pkg, textures, audio and video) belong to their respective authors: only use assets you own or are licensed to use, and don't bundle other people's work into your product or redistribute it publicly.

---

## 赞赏作者 · Sponsor

如果这个项目帮到了你，欢迎请作者喝杯咖啡。 · If this project helps you, consider buying the author a coffee.

| 微信支付 · WeChat Pay | 支付宝 · Alipay |
| --- | --- |
| ![WeChat Pay](https://cdn.jsdelivr.net/gh/oneincase/webwallgl@main/public/imgs/wechat.png) | ![Alipay](https://cdn.jsdelivr.net/gh/oneincase/webwallgl@main/public/imgs/alipay.png) |
