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
import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@1.3.3/webwallgl.min.mjs";
```

```
<!-- 3) UMD <script>: exposes the global WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl@1.3.3/webwallgl.global.min.js"></script>
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
| `setAudio(src)` | Swap the audio spectrum source (pull model, once per frame); null falls back to the built-in sim. Survives scene changes. Works for scene and web |
| `setMedia(src)` | Swap the system media source (Now Playing); shared by scene and web, survives scene changes |
| `media` | Media control surface: read snapshot, plus skipNext / skipPrevious / play / pause / playPause transport control |
| `pushPointer(u, v, buttons?)` | Inject pointer state (u/v normalized 0..1). For hosts whose window cannot receive the mouse; works for scene and web |
| `pointerLeave()` | Pointer left: clears buttons but keeps the last position (dropping it makes parallax and xray visibly jump) |
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

## Three wallpaper types: scene / video / web

You never branch on type yourself: mount() reads project.json first and routes on its type — web goes to a sandboxed iframe, video / gif / image take the media path, everything else goes through scene assembly. All three share one mount() and one SceneInstance; pause/resume, setVolume, stats and friends work the same way.

```
// One code path for any type (pass a container div — see the previous section)
const wp = await mount(document.querySelector("#wp"), {
  source: httpSource("https://cdn.example.com/wallpapers/3789109327"),
});
console.log(wp.info); // { width, height, layerCount, ... }
```

- A video wallpaper's asset URL comes from Source.mediaEntry(); httpSource implements it (reads project.json's file field and joins {base}/{file})
- For arbitrary video/images use mediaSource(): mediaSource(url) or mediaSource(file) — the type is inferred from the extension, no project.json needed
- An explicit project.type always wins; sniffing only fills in when it is absent — some scene wallpapers point project.file at an .mp4 (a video texture inside the scene, not "this wallpaper is a video")
- Media wallpapers need WebGL2; when it is unavailable the failure arrives via onError for you to handle — the library does not silently switch to DOM rendering
- pause/resume, setVolume, setFps and setFit all work on media wallpapers too (setVolume drives the &lt;video> element's volume and muted directly)

```
import { mount, mediaSource } from "webwallgl";

// Remote video: type inferred from the extension; a signed URL's ?query is stripped correctly
await mount(box, { source: mediaSource("https://cdn/clip.mp4?token=…") });

// Local import: a video/image from drag & drop or <input type=file>
input.addEventListener("change", async () => {
  const wp = await mount(box, { source: mediaSource(input.files[0]) });
  // destroy() revokes the objectURL the library created internally
});

// Specify explicitly when the extension is unreliable
mediaSource(streamUrl, { type: "video" });
```

## System media (Now Playing) & transport control

"Now Playing" wallpapers read the title, artist, progress, cover palette and lyrics; some also have previous/next/play-pause buttons. All of it comes from a single MediaSource — **scene and web wallpapers share one instance**, so the host maintains a single driver and both wallpaper types see the same data.

```
import { mount, createMediaSource } from "webwallgl";

// Supply only what you have; the library fills in palette, lyric line and trackIndex
const media = createMediaSource(
  { title: "Night Star", artist: "Phase Shift", playing: true,
    position: 30, duration: 212,
    lyrics: [[0, "first line"], [20, "second line"]] },
  // Transport control: wallpaper buttons call these; forward them to the real player
  { skipNext: () => player.next(),
    playPause: () => player.toggle() },
);

const wp = await mount(box, { source, media });

// Update when the system's Now Playing changes (the lyric line re-resolves from position)
media.set({ title: "Next Track", position: 0 });

// You can also install / swap / remove it after mounting
wp.setMedia(media);
wp.setMedia(null);        // fall back to the built-in simulation

// The host can read the snapshot and issue transport commands too
console.log(wp.media.snapshot.title);
wp.media.playPause();
```

- The five palette fields must be chainable color objects (scripts write c.subtract(o).multiply(t).add(o); a plain array throws a TypeError that kills the whole script) — createMediaSource guarantees this for you
- All transport methods are optional: if you only provide metadata, wallpaper buttons are silently inert rather than throwing
- setMedia survives scene changes: install once and it applies to every scene loaded afterwards
- For video wallpapers the audio spectrum is captured from the &lt;video> automatically (visualizers react to the video's own audio); an explicit setAudio() injection takes precedence

## Injecting pointer & audio

A wallpaper host often cannot rely on the browser's native input: desktop wallpapers sit in the desktop underlay layer where the system's desktop window swallows mouse events, and the audio spectrum has to be captured by the host itself. Both channels are fed through instance methods.

```
// Pointer: u/v are normalized 0..1; buttons matches MouseEvent.buttons
wp.pushPointer(0.5, 0.5, 0);   // hover at the center
wp.pushPointer(0.5, 0.5, 1);   // press the left button
wp.pointerLeave();             // pointer left (clears buttons, keeps last position)

// Audio: pull model — the render loop calls snapshot() once per frame
let latest = { left: new Float32Array(64), right: new Float32Array(64) };
wp.setAudio({ snapshot: () => latest });

// e.g. update `latest` from the host's spectrum stream
evtSource.onmessage = (e) => { latest = JSON.parse(e.data); };

wp.setAudio(null);             // remove the source, fall back to the built-in sim
```

- Injected pointer state coexists with the canvas's own DOM listeners — last writer wins. It works for scene and web wallpapers; media wallpapers have no pointer concept, so the call is silently inert
- Audio contract: 64 bands per channel, values 0..1. Short arrays are zero-padded and long ones truncated; the 32/16-band downsamples plus level and silence detection are derived by the library
- Returning null (or throwing) from snapshot() means "no data this frame" and the engine falls back to the built-in simulation — no special handling needed while host capture is still warming up
- setAudio survives scene changes: install it once and it applies to every scene loaded afterwards
- Audio injection works for both scene and web wallpapers: the web side receives the same data through the iframe shim audio pump, and both pumps pick their source per frame so calling setAudio after mount() works too

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

Current version: 1.3.3. This section records only user-visible changes (API, behavior, compatibility, fidelity), each backed by a commit in the repository; pure internal refactors and verifier scripts are omitted.

| Version | Date | Notes |
| --- | --- | --- |
| `1.3.3` | 2026-09-08 | Full audit: fixed autoplay:false hanging mount(), setMedia being inert on the scene path, AudioContext leaking on wallpaper swap, and more |
| `1.3.2` | 2026-09-08 | Fix: the "live system" microphone only fed scene wallpapers; web wallpaper visualizers still showed the synthetic stream |
| `1.3.1` | 2026-09-08 | Fix: injected audio/media sources never reached web wallpapers (visualizers kept playing the default stream) |
| `1.3.0` | 2026-09-08 | mediaSource() for arbitrary video/images; type sniffing; volume for media wallpapers; one Now Playing driver shared by scene and web |
| `1.2.0` | 2026-09-08 | Video wallpapers work through the library entry; audio and pointer injection wired into the public API (three downstream reports) |
| `1.1.0` | 2026-09-07 | External pointer injection channel, web wallpaper interaction, effect-pass compile fixes, complete pause semantics |
| `1.0.0` | 2026-09-06 | First stable release: the public API is settled (mount / SceneInstance / Source) |
| `1.0.0-beta1` | 2026-09-04 | First public preview |

1.3.3 is a full audit covering unwired API, defects and memory leaks. Everything fixed here was confirmed by measurement:

- **autoplay:false hung mount() forever** (scene and media wallpapers): pausing before assembly meant the render loop never ran a single frame, so the only first-frame trigger was unreachable and the promise neither resolved nor rejected. Measured: the same wallpaper resolved by default but was still pending after 500 live rAF frames with autoplay:false. It now assembles normally and pauses after the first frame is drawn
- The first-frame callback now fires after render() completes (previously it ran before the render call, landing one frame early, so autoplay:false handed back a blank canvas)
- **setMedia() was inert on scene wallpapers**: the scene captured its media driver once at assembly, while setMedia is typically called after mount(). It now re-picks on every read (the web path already did)
- **Swapping wallpapers leaked an AudioContext**: the video spectrum takeover registered its release on the instance-level list, but swapping goes through clear() while only destroy() drained it. Browsers cap out at roughly 6 AudioContexts, after which audio reactivity silently dies. A per-wallpaper release list is now drained by clear()
- **One throwing cleanup dropped the entire teardown**: clear() called the assembly-layer cleanup without try/catch, so a single exception skipped the WebGL context release, video element recycling and blob revocation that followed
- **Swapping wallpapers during the mic permission prompt orphaned the stream**: getUserMedia blocks on the system dialog, and the release was registered after the await, so nothing on that path ever called it and the browser's recording indicator stayed lit. Both assembly paths now register the release slot synchronously
- The instance.media control surface is reset by clear() (previously it still pointed at the destroyed scene's sandbox closures after release()/destroy())

Still unwired by design (marked in the type comments): MountOptions' pointer and features. Use pushPointer() to feed pointer state from outside.

1.3.2 closes the **second channel** of the same symptom: 1.3.1 fixed host injection (setAudio), while the bench's "live system" checkbox takes a different path (cfg.liveSystem, where the library captures the microphone itself). That path was only consumed by the scene assembly — web.ts referenced liveSystem zero times — so ticking the box made scene visualizers follow the mic while web wallpapers stayed on the synthetic stream.

- Web wallpapers now receive the live-system microphone through the same capture path as scene (startLiveSystem)
- Microphone capture is asynchronous (getUserMedia needs user consent) and does not block pump startup: the default source runs first, then the mic is filled in and the per-frame source pick switches over
- Audio source priority: host injection (setAudio) > live-system microphone > built-in simulation
- The microphone stream is released on teardown (otherwise the browser's recording indicator stays lit)

1.3.1 fixes a defect found downstream in real use: **the microphone was connected, yet web wallpapers kept showing the default synthetic stream**.

- Root cause 1: the web assembly path never read rt.audioBridge (1.3.0 wired this up for the media source but missed the audio line), so injected spectra never reached the iframe
- Root cause 2: both the audio and media pumps captured their driver at assembly time, while setAudio()/setMedia() are typically called after mount() (that is when the host's microphone or SSE channel becomes ready) — a fixed driver means a later source never takes effect. Both pumps now pick their source per frame and fall back cleanly when the source is removed
- Injected spectra are no longer put through the gamma contrast expansion: that step exists for the built-in simulation's unclamped bands, and applying it to a host's already-normalized 0..1 spectrum would peg every bar at full scale

1.3.0 continues directly from 1.2.0, closing four more items reported by the downstream host:

- New mediaSource(urlOrFile): any video or image can be a wallpaper, from a remote URL or a local File (drag & drop). The library revokes the objectURL on destroy()/source swap — without that, every wallpaper change would leak a multi-megabyte blob
- Type sniffing: with no project.type the URL extension decides (correctly stripping a signed URL's ?query and #hash), falling back to scene only when unrecognized. An explicit project.type always wins and is never overridden
- setVolume now works on media wallpapers (previously a complete no-op — volume only reached the scene audio graph). It writes both volume and muted, since changing volume on a muted &lt;video> does nothing; if unmuting is blocked by the autoplay policy that is reported via onDiagnostic rather than silently swallowed
- MediaSource was widened to the driver's real contract (an 18-field snapshot plus five optional transport methods) and is now **one shared instance across scene and web** — previously each side created its own simulation with no way for the host to inject. The new createMediaSource() takes only the fields you have and fills in palette, lyric line and trackIndex, guaranteeing chainable color instances
- New SceneInstance.setMedia() and a media control surface (snapshot plus previous/next/play-pause); transport commands forward straight to the host driver, and host-side data updates are visible to the engine in the same frame
- Video wallpapers capture their spectrum from the &lt;video> itself so visualizers react to the video's own audio; an explicit setAudio() injection takes precedence

1.2.0 closes three gaps where the runtime capability already worked but was never exposed through the library entry (reported by the downstream host wallpaperEM):

- video / gif / image wallpapers can now be mounted via mount(): a new Source.mediaEntry() supplies the URL and the media path gained the library contract it lacked. Previously it fired neither onFirstFrame nor onError, so even with routing in place the mount() promise would hang forever — never resolving, never rejecting
- The media path now honors a caller-supplied canvas and sizes its backing store from CSS dimensions rather than the window (previously an embedded canvas got a full-window buffer and was never inserted into the DOM at all)
- MountOptions.audio is actually wired now (it was a declared-but-unreferenced dead field), plus a new SceneInstance.setAudio() for swapping after mount — host spectrum channels usually become ready only after mount()
- New SceneInstance.pushPointer() / pointerLeave(), matching the full-page renderer's __wp in both name and signature so downstream code needs no changes when migrating to the library
- Known boundaries at the time: audio injection was scene-only — web wallpapers use a separate iframe-shim channel, wired up in 1.3.1; media wallpapers have no pointer concept; MountOptions' pointer / media / features were unwired (media landed in 1.3.0)

What went into 1.1.0 (merged after 1.0.0):

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
