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
import { mount, httpSource } from "https://cdn.jsdelivr.net/npm/webwallgl@1.3.22/webwallgl.min.mjs";
```

```
<!-- 3) UMD <script>: exposes the global WebWallGL -->
<script src="https://cdn.jsdelivr.net/npm/webwallgl@1.3.22/webwallgl.global.min.js"></script>
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
| `1.3.16` | 2026-09-11 | Media-component fixes and branding: (1) album covers on 33 wallpapers rendered as black placeholders because the $mediaThumbnail / $mediaPreviousThumbnail binding in an effect pass usertextures slot was dropped by parsing; the binding is now merged so covers show. (2) media title/artist layers were blank because width-limited wrapping was squeezed by the 2x2 placeholder box; the text canvas now grows only for placeholder-sized boxes, and typewriter scripts no longer stick at the placeholder text. (3) simulated audio is now true stereo. (4) the simulated media source is rebranded: title WebWallGL, artist oneincase, cover is the library logo. (5) fix lost font after the shared text canvas is resized: assigning textCanvas.width/height resets the 2D context and wipes the font back to the default 10px, so large clocks/dates were nearly invisible (2468489223, 3379996991); drawing now uses an explicit font string. (6) fix clock/date scripts misclassified as writeback and having their text cleared (3379996991). |
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
| `pushPointer(u, v, buttons?, mods?)` | Inject pointer state (u/v normalized 0..1; mods is a ctrl/shift/alt/meta mask). For hosts whose window cannot receive the mouse; works for scene and web |
| `pointerLeave()` | Pointer left: clears buttons but keeps the last position (dropping it makes parallax and xray visibly jump) |
| `pushWheel(dx, dy, mode?, mods?)` | Inject wheel / trackpad gestures (web wallpapers only). Positive dy scrolls content down; a macOS pinch maps to the ctrl bit in mods |
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

A wallpaper host often cannot rely on the browser's native input: desktop wallpapers sit in the desktop underlay layer where the system's desktop window swallows mouse and wheel events, and the audio spectrum has to be captured by the host itself. These channels are fed through instance methods.

```
// Pointer: u/v are normalized 0..1; buttons matches MouseEvent.buttons
wp.pushPointer(0.5, 0.5, 0);   // hover at the center
wp.pushPointer(0.5, 0.5, 1);   // press the left button
wp.pointerLeave();             // pointer left (clears buttons, keeps last position)

// Wheel / trackpad (web wallpapers only): dy matches DOM deltaY; mode 0=px 1=line 2=page
wp.pushWheel(0, 100, 0, 0);    // two-finger scroll down one notch
wp.pushWheel(0, -50, 0, 1);    // macOS pinch = ctrl bit (mods bit0)

// Audio: pull model — the render loop calls snapshot() once per frame
let latest = { left: new Float32Array(64), right: new Float32Array(64) };
wp.setAudio({ snapshot: () => latest });

// e.g. update `latest` from the host's spectrum stream
evtSource.onmessage = (e) => { latest = JSON.parse(e.data); };

wp.setAudio(null);             // remove the source, fall back to the built-in sim
```

- Injected pointer state coexists with the canvas's own DOM listeners — last writer wins. It works for scene and web wallpapers; media wallpapers have no pointer concept, so the call is silently inert
- pushWheel only affects web wallpapers: scenes have no wheel API (zero consumers across 194 scene wallpapers tested). The web side synthesizes both the modern wheel and the legacy mousewheel — the only wallpaper that genuinely uses the wheel (a 360° panorama, 3406740580) listens solely to the legacy event, while three.js OrbitControls listens solely to the modern one. DOMMouseScroll is deliberately not dispatched, or the same scroll would be processed twice
- macOS trackpad: feed two-finger scrolls as pixel deltas (mode=0); map a two-finger pinch to ctrl+wheel (mods bit0), exactly as browsers do — OrbitControls / pano2vr rely on that bit to tell zoom from scroll
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

Current version: 1.3.22. This section records only user-visible changes (API, behavior, compatibility, fidelity), each backed by a commit in the repository; pure internal refactors and verifier scripts are omitted.

| Version | Date | Notes |
| --- | --- | --- |
| `1.3.22` | 2026-09-15 | SceneScript lifecycle, particle script hooks and built-in-music response wired up, raising fidelity: (1) the `resizeScreen(size)` lifecycle event is dispatched in **CSS pixels** when the window/resolution changes (including the first frame and portrait orientation) and `engine.screenResolution` updates with it, so adaptive-scale wallpapers (3396722575/3405117965/3002120692) are no longer locked to a 1920×1080 layout. (2) `engine.timeOfDay` previously sampled once at mount, so day/night and night-light wallpapers (6 wallpapers incl. 2134765860/3151551777) never transitioned no matter how long they ran; it now refreshes per second with real time. (3) SceneScript `localStorage` now matches WE semantics: shared by all scripts of one wallpaper, persisted across sessions, with `LOCATION_SCREEN`/`LOCATION_GLOBAL` and the WE `delete` name; by default the library uses browser localStorage namespaced per wallpaper, and hosts can inject a custom persistent backend via the new `cfg.storageProvider`. (4) Particle `instanceoverride` scripts (29 wallpapers) are connected: rate/count/size/alpha/color can be driven per frame (e.g. by audio). (5) `animationlayers` visibility scripts and `thisLayer.getAnimationLayer(name)` are connected (8 wallpapers, puppet "frame-offset" mechanism), plus `originalOrigin` (drag reset) and `getMaterial(index)` (editing material constants no longer crashes the script). (6) **built-in BGM now drives audio visualization** — previously the wallpaper's own music played but bars/particles only reacted to the simulated or microphone source (35 wallpapers). (7) materials with LIGHTING enabled now receive ambient light from `general.ambientcolor`. |
| `1.3.21` | 2026-09-14 | Fixed a toggle whose state changed but whose knob didn't slide (2983846453): scripts writing via `thisScene.getLayer(x).origin=` hit the world slot while the bound field was overwritten every frame from the local basis, cancelling the movement; reads and writes now consistently use local space. Also includes the follow-up fix for variable-length bone-name MDLS parsing from 3463520581 |
| `1.3.20` | 2026-09-14 | Fixed visible transparent squares on soft particles such as car exhaust and human breath (2241938645/2250845956): the low-alpha fringe of built-in smoke/fog textures was magnified by large sprites into straight-edged gray veils; now sealed with a gaussian radial falloff, affecting ~110 wallpapers |
| `1.3.19` | 2026-09-13 | Fixed the real cover still showing the placeholder ring/blank while a song plays (2388299037): the cover texture used trilinear mip sampling but uploading a real cover wrote only level 0 without rebuilding mips, so downscaled sampling kept reading the old placeholder; mips are now rebuilt on upload. Cover/metadata priority is now "external real > simulated/test > bundled" |
| `1.3.18` | 2026-09-13 | Fixed rain scenes whose sky cloud layer was completely static, looking like a white veil (959417181 and ~20 others): the cloud-density effect referenced the WE-bundled public texture `util/clouds_256`, which isn't in the pkg, falling back to a 1×1 white board so the cloud map was constant and couldn't drift; now a tileable periodic-noise cloud texture is generated procedurally (uv grows unbounded with time, using repeat wrapping), plus `util/black` |
| `1.3.17` | 2026-09-13 | (1) Glow particles were too bright and washed out the scene (3151551777): the material constant `ui_editor_properties_overbright` (0.17–10, 68 wallpapers / 159 materials) was dropped and treated as 1.0, oversaturating the bright core; it now multiplies instance brightness correctly. (2) Now-playing metadata didn't show: per WE semantics a wallpaper's own .ogg doesn't raise system media events, so the panel could only show branded placeholder; sound layers explicitly `play()`-ed by scripts are now surfaced as a media snapshot (ambient sound doesn't hijack the panel); also fixed a race where constant animations were built before the constant-script sandbox so `getAnimation().play()` silently no-op'd, and right-aligned long titles being clipped by the text canvas |
| `1.3.15` | 2026-09-08 | The video pair gains a self-healing watchdog: elements can enter "phantom playback" (paused=false but the decoder stalls and time stops advancing, with no event to listen for), freezing the wallpaper permanently — the render loop now detects currentTime not advancing for ~500ms on a visible page and hard-restarts decode via pause→play; legitimate throttling while the page is occluded is not misjudged |
| `1.3.14` | 2026-09-08 | Fourth pass at loop handover: the hard cut became a fast fade. Crawling keeps the layer beneath already moving while the old main (holding its last frame) fades out linearly over 64ms — the blend window masks the 1–3 frames of imprecision inherent to element-level handover (ended dispatch, layer-swap compositing) instead of requiring every stage to be zero-latency |
| `1.3.13` | 2026-09-08 | Third pass at seamless-loop handover, "crawling": during the main video's final 0.12s the standby actually plays at 1/8 rate (its pipeline stays in the playing state while advancing only ~1 frame); on ended the rate flips back to 1x and layers swap in the same tick — a rate change is a pure clock operation, removing both the wakeup/freeze and the content jump of earlier versions |
| `1.3.12` | 2026-09-08 | Loop handover refined again: pre-play removed (it caused a transient dual-4K-decode contention plus a content jump at the swap); the main video now holds its last frame on ended while the standby is started and confirmed to actually advance before layers swap — the hold lands on the content cut, reading as a normal edit |
| `1.3.11` | 2026-09-08 | Seamless-loop handover reworked to "pre-play + exact ended swap": the standby actually starts playing underneath the main video a few frames before the end, and layers swap the instant ended fires (frame-exact, not polled) — eliminating the resume-wakeup latency and rAF detection lag behind the last 1–2 frame hitch |
| `1.3.10` | 2026-09-08 | destroy() gains a releasePkgCache option: destroying an instance also evicts that wallpaper's parsed scene.pkg cache (previously the old package stayed cached after switching, so memory never dropped) |
| `1.3.9` | 2026-09-08 | New pushWheel channel for wheel / macOS trackpad injection (web wallpapers only): synthesizes wheel plus the legacy mousewheel, and maps a two-finger pinch to ctrl+wheel; pushPointer gains an optional modifier mask |
| `1.3.8` | 2026-09-08 | Video wallpapers now render as DOM video: 4K is no longer downsampled to 2048 (sharpness) and an A/B element pair gives seamless looping (loop-point hitch 84ms→33ms); the in-scene video texture cap now follows the render target too |
| `1.3.7` | 2026-09-08 | Fix: the library entry's setRenderDpr / restore remount went fully black (it reused a canvas whose context had been lost); scene wallpapers now support the real cover texture via $mediaThumbnail |
| `1.3.6` | 2026-09-08 | New MediaSnapshot.thumbnail: the host can now pass the real album cover to web wallpapers (previously only colors were available, and the cover was always a gradient placeholder) |
| `1.3.5` | 2026-09-08 | xray effect: when the author doesn't configure size in the scene, the fallback is now 1 (identity) instead of the shader comment's 0.2 |
| `1.3.4` | 2026-09-08 | Closes the four items deferred from 1.3.3: setFit now affects web wallpapers, audio:null truly mutes, the bare-iframe fallback no longer reports 0 fps, and debug globals are cleared on unmount |
| `1.3.3` | 2026-09-08 | Full audit: fixed autoplay:false hanging mount(), setMedia being inert on the scene path, AudioContext leaking on wallpaper swap, and more |
| `1.3.2` | 2026-09-08 | Fix: the "live system" microphone only fed scene wallpapers; web wallpaper visualizers still showed the synthetic stream |
| `1.3.1` | 2026-09-08 | Fix: injected audio/media sources never reached web wallpapers (visualizers kept playing the default stream) |
| `1.3.0` | 2026-09-08 | mediaSource() for arbitrary video/images; type sniffing; volume for media wallpapers; one Now Playing driver shared by scene and web |
| `1.2.0` | 2026-09-08 | Video wallpapers work through the library entry; audio and pointer injection wired into the public API (three downstream reports) |
| `1.1.0` | 2026-09-07 | External pointer injection channel, web wallpaper interaction, effect-pass compile fixes, complete pause semantics |
| `1.0.0` | 2026-09-06 | First stable release: the public API is settled (mount / SceneInstance / Source) |
| `1.0.0-beta1` | 2026-09-04 | First public preview |

The full commit history lives in the GitHub repository; every fix records its symptom, root cause, measured scope and verification method in the commit message.

## Copyright & compliance

The library code is MIT. Wallpaper Engine workshop assets (scene.pkg, textures, audio/video) remain copyrighted by their authors: point the library only at content you own or are licensed to use, and don't redistribute other people's work through your product.

## Sponsor the author

If this rendering core helped your project, buying the author a coffee is always appreciated. Scan the QR code to sponsor — any amount counts.

| WeChat Pay | Alipay |
| --- | --- |
| ![WeChat Pay QR code](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/wechat.png) | ![Alipay QR code](https://raw.githubusercontent.com/oneincase/webwallgl/main/public/imgs/alipay.png) |
