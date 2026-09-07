# WebWallGL — Wallpaper Engine scene renderer for the browser

**[简体中文](README.md) | [English](README.en.md)**

## Introduction

WebWallGL is a browser-side renderer for Wallpaper Engine wallpapers — scene, video, and web: its main job is replaying workshop scene packages (scene.pkg) in WebGL in real time, with layer effect chains, particles, 3D puppet bones, text widgets, script sandboxes, audio response and live user-property updates; web wallpapers run in a sandboxed iframe with a WE API shim injected before author scripts. Upcoming versions will add effects exclusive to this library — stay tuned.

- [GitHub repository](https://github.com/oneincase/webwallgl)
- [Live demo (GitHub Pages)](https://oneincase.github.io/webwallgl/)

- Zero runtime dependencies, single-file delivery (min ESM ~270KB / gzip ~90KB)
- Installable via npm or a &lt;script> CDN tag; multiple isolated instances per page
- This bench is the library's first consumer — everything you see here is public API

## What can you build

WebWallGL is a 'wallpaper-compatible rendering core' — anywhere a "dynamic background" is needed, drop in a WebWallGL instance:

- Wallpaper apps: the core renderer for desktop wallpaper engines (Tauri / Electron / WebView shells), fully replaying WE workshop scenes
- Websites: animated backgrounds or full-screen hero sections for homepages, landing pages and product sites
- Dev tools: background layers for dashboards, monitoring walls, terminals and GUI launchers
- Background plugins: embedded render source for music visualizers, OBS backdrops, digital signage and widget engines

In one line: everything can be a wall. Your app provides a canvas and a source for the scene package — parsing, assembly, the render loop, script sandboxes, pointer and audio are all WebWallGL's job.

## Installation

Three ways to include it — pick one (CDN examples pin the currently released version):

```
// 1) npm + bundler (recommended)
npm i webwallgl           // tracks the latest release; pin the test build with npm i webwallgl@beta
import { mount, httpSource } from "webwallgl";
```

```
// 2) ESM CDN via jsDelivr (without a bundler)
import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@1.1.0/webwallgl.min.mjs";
```

```
<!-- 3) UMD <script>: exposes the global WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl@1.1.0/webwallgl.global.min.js"></script>
<script>
  const { mount, httpSource } = WebWallGL;
</script>
```

## Quick start

One canvas plus one source is everything. mount() resolves after the first frame is actually drawn:

```
<canvas id="wp" style="width:100%;height:400px"></canvas>

import { mount, httpSource } from "webwallgl";

const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/3122339805"),
  fps: 60,
});

// The instance is ready to use after the first frame:
wp.pause();
wp.resume();
wp.setProperties({ schemecolor: "0.5 0.2 0.8" });
console.log("live fps:", wp.stats.fps);
```

The canvas CSS size is the render size: the library aligns the backing store to clientWidth/clientHeight, and the aspect follows container resizes automatically — no manual resize handling.

## Mount target: canvas or container div

mount() takes any HTMLElement as its first argument, not just a canvas. Pass a canvas and it is used directly; pass a plain container (a div, say) and the library creates a full-bleed canvas inside it (tagged data-webwallgl, reused on remount; a position:static container is switched to relative).

This is not a style choice — **web wallpapers require a container**. A web wallpaper does not use WebGL; the library appendChild()s a sandboxed iframe into the element you pass, and a canvas cannot have children, so passing one fails. If the same code path must handle both scene and web wallpapers (a general wallpaper player, say), always pass a div:

```
<!-- Works for both wallpaper types -->
<div id="wp" style="position:relative;width:100%;height:400px"></div>

// Scene wallpaper: the library builds a canvas inside the div
// Web wallpaper:   the library mounts a sandboxed iframe inside the div
const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/2517518192"),
});

// wp.canvas is always readable: the real canvas on the scene path,
// the container you passed on the web path
console.log(wp.canvas);
```

- You never branch on type yourself: mount() reads project.json first — type "web" takes the web path, everything else goes through scene assembly
- The web entry URL resolves as Source.webEntry() → {httpSource base}/{project.file or index.html}; if neither yields a URL, mount throws
- On the web path the WebGL-side options (fit / renderDpr / features) do not apply; pause/resume, setVolume and setProperties still work, relayed to author code through the shim

## Loading scenes: Source

The library makes only two network requests (scene.pkg and optional project.json), so the resource abstraction is one interface with three built-in implementations:

| Factory | Use case |
| --- | --- |
| `httpSource(baseUrl, init?)` | HTTP base URL; falls back through the three real layouts: scene.pkg → scenes/scene.pkg → gifscene.pkg |
| `fileSource(file, project?)` | A local .pkg from &lt;input type=file> or drag & drop |
| `bytesSource(pkg, project?, key?)` | Bytes already in hand (bundled, IndexedDB cache, custom transport) |

```
// Local file: drop a scene.pkg into the page to preview it
input.addEventListener("change", () => {
  const src = fileSource(input.files[0]);
  mount(canvas, { source: src });
});
```

- httpSource tries the root scene.pkg first and tolerates each fetch separately — WKWebView/custom protocols throw Failed to fetch instead of a 404; the wrong order breaks every wallpaper
- source.key feeds the library's parse cache: packages with the same key are parsed once (pause/property changes cost zero network)
- A missing project.json is normal: without a property table, fields fall back to the scene.json snapshot values

## Mount options

| Option | Default | Description |
| --- | --- | --- |
| `source (required)` | `—` | See Source above |
| `fit` | `"cover"` | cover crops to fill / contain letterboxes / stretch distorts |
| `renderDpr` | `1` | Render DPR cap (effective = min(devicePixelRatio, renderDpr)); lower it to save VRAM |
| `fps` | `60` | FPS cap; skipped frames don't count into stats.fps, so drops are visible |
| `volume` | `0` | 0..1. Starts muted (autoplay policy); set a non-zero volume after ready |
| `autoplay` | `true` | When false, stays paused after mount |
| `properties` | `{}` | Initial user property overrides (keys are property names) |
| `pointer / audio / media` | `built-in` | Pointer follows the canvas; audio/media are deterministic sims; pass null to disable |
| `features` | `all on` | Debug switches: models / text / particles / effects / components |
| `onReady / onError / onDiagnostic` | `—` | Callback surface; can also subscribe later via instance.on() |

## The SceneInstance API

| Member | Description |
| --- | --- |
| `pause() / resume() / paused` | Pause/resume. Never remounts the package: video/audio resume from where they were |
| `setFit(fit) / setFps(n) / setVolume(v)` | Live updates, no remount (the render loop reads them per frame) |
| `setRenderDpr(dpr)` | Changing DPR rebuilds the canvas; remounts internally (pkg cache hit, no re-download) |
| `setProperties(props)` | Live property updates: patches the property table / effect constants / script sandboxes in place, no re-fetch |
| `getProperties()` | The current flattened property value map |
| `load(source)` | Switch scenes reusing the same canvas and WebGL context; resolves after the first frame |
| `release() / restore()` | Free GL resources keeping the config (display sleep) / rebuild from the kept config |
| `destroy()` | Terminal: frees resources, unbinds listeners; the instance is dead afterwards |
| `stats / info` | Measured FPS ({fps, running}, zeroes out instead of freezing) / scene info (logical size, layer count, has models/particles/text) |
| `on(ev, fn)` | Subscribe to ready / error / diagnostic; returns an unsubscribe function |

## User properties

User properties are the settings a wallpaper author exposes in WE (colors, toggles, sliders, dropdowns), declared under general.properties in project.json. Keys are the author's property names (typically things like schemecolor or newproperty12); values must be scalars matching the property type:

| Property type | What to pass | Example |
| --- | --- | --- |
| `color` | A "r g b" string: three 0..1 floats separated by spaces (not #RRGGBB, not 0..255) | `"0.5 0.2 0.8"` |
| `bool` | A boolean | `true` |
| `slider` | A number within the author's min/max | `100` |
| `combo` | The option value; pass a number when options are integers (integer strings also work) | `1` |
| `textinput / file / directory` | A string | `"https://…/clock.png"` |

```
// First see which properties this wallpaper has and their current values
console.log(wp.getProperties());
// → { schemecolor: "0 0 0", newproperty12: true, … }

// Then set them by name (pass only what you change; the rest stays put)
wp.setProperties({ schemecolor: "0.5 0.2 0.8", newproperty12: false });
```

- Property names differ per wallpaper; there is no cross-wallpaper naming convention — read getProperties() first instead of hardcoding guesses
- Writing a name the current scene doesn't declare raises no error: the value still lands in the table (a later scene may use it) but changes nothing on screen — a typo shows up as "nothing happened", not as an exception
- setProperties() patches in place — property table, effect constants and script sandboxes — with no re-fetch and no re-parse
- Wallpapers without a project.json still run: the property table is empty and fields fall back to the scene.json snapshot values

## Events & diagnostics

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

The library ships no fallback page and phones home nowhere: diagnostics and errors arrive via callbacks only. What to do on failure (show a hint, swap the wallpaper, destroy the instance) is your call.

## Multiple instances per page

```
const a = await mount(c1, { source: httpSource(urlA) });
const b = await mount(c2, { source: httpSource(urlB) });
b.pause(); // does not affect a
```

- Each instance owns a Runtime: config, FPS meter, WebGL context and property table are fully isolated
- Pointer events bind to each instance's canvas; normalized coordinates are canvas-relative and never capture the page
- Mind WebGL context limits: browsers allow ~8–16 per page and drop the oldest beyond that

## Lifecycle & caching

- Parsed scene.pkg entries are cached by source.key (up to 2): pause/resume, property changes and setRenderDpr remounts never re-download
- After release(), stats.running goes false and the FPS reading zeroes out — a stopped meter must not freeze on its last value
- After destroy() the canvas is yours again; mount() a fresh instance any time
- load() puts the instance back into the playing state (even if it was paused before); call pause() again after load() to stay paused
- load() re-applies the properties given at mount time; values set later via setProperties() do not carry over — property names are per-scene anyway, so re-apply them after load() if you need them

## Troubleshooting

- Black screen with WEBGL2_UNAVAILABLE: no WebGL2 in this environment; there is no software fallback
- HTTP 404: make sure the httpSource directory really contains a scene.pkg (all three layouts are tried before failing)
- Failed to fetch with no status: custom-protocol/WKWebView behavior for missing paths — by design; just read the final error
- stats.fps is 0 while the picture moves: the meter counts committed frames only; browsers suspend rAF for occluded tabs — expected
- Audio starts late: autoplay policy requires user interaction before sound; that's why volume defaults to 0
- Web wallpaper has no audio/properties: the entry HTML must be same-origin or CORS-readable so the library can inject the WE shim; unreadable cross-origin falls back to a bare iframe (no official APIs)
- Web wallpaper relative assets 404: resources rely on &lt;base href> pointing at the original directory; wallpapers that build URLs from location.href may break under blob loading

## Changelog

Current version: 1.1.0. This section records only user-visible changes (API, behavior, compatibility, fidelity), each backed by a commit in the repository; pure internal refactors and verifier scripts are omitted.

| Version | Date | Notes |
| --- | --- | --- |
| `1.0.0` | 2026-09-06 | First stable release: the public API is settled (mount / SceneInstance / Source) |
| `1.0.0-beta1` | 2026-09-04 | First public preview |

After 1.0.0 (unreleased, already on the repository's main branch) — these will ship in the next version:

- New external pointer injection channel (__wp.pushPointer / pointerLeave): when the wallpaper window cannot receive the mouse (e.g. the Finder desktop window swallows events on macOS), the host polls the system cursor and pushes it in. Scene and web wallpapers share one protocol — callers need not branch on type
- Web wallpapers joined the same channel: the shim synthesizes DOM events against the hit element (full over/out/enter/leave chains, click derived from button edges). Of 49 local web wallpapers, interaction went from dead to working on 24 with mousemove, 29 with click and 16 with pointer events. Hard limit: CSS :hover is driven by browser hit-testing and cannot be lit by synthetic events
- Effect-pass compile failures driven to near zero (seven rounds): the transpiler now handles int/float mixing, macro scoping, vector narrowing, scientific notation and more. Library-wide effect-pass compilation went from 1653/1873 (88.3%) to 1823/1873 (97.3%), +170 in total. The symptom was an effect silently missing — a failed compile only warns, so god rays / visualizers / glows simply vanished
- Pause semantics completed: pausing must freeze rAF/timers and CSS animations together (compositor-driven CSS animations ignore JS freezing — 1444432396 kept animating after pause); resuming must re-arm held rAF callbacks (self-recursive rAF wallpapers break their chain permanently — 1278092907 froze forever after resume), restoring only what we paused
- Fidelity fixes: keyframe animations now run on the real clock (previously they accumulated the target frame interval, diverging from the bone clock by 5.5s over 30s — hair desynced from the head and the scalp showed through); object scripts and keyframe animations now work in local space with per-frame parent/child recomposition (previously local return values were written straight into world slots, so elements drifted away untouched and got clipped); hidden mask layers referenced by clipping_mask now correctly read back what is behind them (previously they fell back to the referencing layer itself, painting a solid white block)
- Two new documentation sections, "Mount target" and "User properties": web wallpapers require a container div rather than a canvas, and what value shape each property type expects

The full commit history lives in the GitHub repository; every fix records its symptom, root cause, measured scope and verification method in the commit message.

## Copyright & compliance

The library code is MIT. Wallpaper Engine workshop assets (scene.pkg, textures, audio/video) remain copyrighted by their authors: point the library only at content you own or are licensed to use, and don't redistribute other people's work through your product.

## Sponsor the author

If this rendering core helped your project, buying the author a coffee is always appreciated. Scan the QR code to sponsor — any amount counts.

| WeChat Pay | Alipay |
| --- | --- |
| ![WeChat Pay QR code](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/wechat.png) | ![Alipay QR code](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/alipay.png) |
