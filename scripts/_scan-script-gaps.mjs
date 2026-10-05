#!/usr/bin/env node
/**
 * 全库扫 scene.json 脚本里的 API 引用，对照沙箱已实现面，列出待补清单。
 * 一次性排查脚本，不进 pnpm check。
 */
import { parsePkg, getEntry } from "../renderer/vendor/we-scene/pkg/container.js";
import fs from "node:fs";
import { join } from "node:path";
import { LIB, dec } from "./lib/verify-kit.mjs";


function walkScripts(node, out, depth = 0) {
  if (depth > 40 || node == null) return;
  if (typeof node === "string") return;
  if (Array.isArray(node)) {
    for (const x of node) walkScripts(x, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  if (typeof node.script === "string" && node.script.length > 8) out.push(node.script);
  for (const v of Object.values(node)) walkScripts(v, out, depth + 1);
}

const KNOWN_ENGINE = new Set([
  "registerAsset", "frametime", "runtime", "canvasSize", "screenResolution", "timeOfDay",
  "userProperties", "AUDIO_RESOLUTION_16", "AUDIO_RESOLUTION_32", "AUDIO_RESOLUTION_64",
  "registerAudioBuffers", "setTimeout", "clearTimeout", "setInterval", "clearInterval",
  "openUserShortcut", "isRunningInEditor",
]);
const KNOWN_SCENE = new Set([
  "getLayer", "createLayer", "destroyLayer", "sortLayer", "getLayerIndex", "enumerateLayers", "getAnimation",
]);
const KNOWN_LAYER_METH = new Set([
  "getBoneCount", "getBoneTransform", "setBoneTransform", "applyBonePhysicsImpulse",
  "getParent", "getChildren", "getAnimation", "getAnimationLayer", "getAnimationLayerCount",
  "getTextureAnimation", "play", "pause", "stop", "isPlaying", "getVideoTexture",
  "getTransformMatrix", "getEffect",
]);
const KNOWN_INPUT = new Set([
  "cursorWorldPosition", "cursorScreenPosition", "cursorPosition", "cursorPositionLast",
  "cursorLeftDown", "x", "y", "z",
]);

// 官方 assets/scripts/jsclasses/baseclasses.js 里 Vec2/Vec3/Vec4/Mat3/Mat4 的实例方法全集。
const OFFICIAL_VEC_METH = [
  "length", "lengthSqr", "distance", "distanceSqr", "normalize", "copy", "equals", "isFinite",
  "negate", "add", "subtract", "multiply", "divide", "dot", "cross", "reflect", "refract",
  "perpendicular", "project", "angle", "angleBetween", "rotate", "mix", "min", "max", "clamp",
  "abs", "sign", "round", "floor", "ceil", "fract", "mod", "step", "smoothStep", "toSpherical",
  "toConfigString", "transformPoint", "transformDirection", "transpose", "inverse",
  "determinant", "decompose", "translation", "right", "up", "forward", "extractEuler",
  "normalMatrix", "translate", "scale",
];
const vecMethHits = new Map();
const classHits = new Map();

const engineHits = new Map();
const sceneHits = new Map();
const layerMethHits = new Map();
const inputHits = new Map();
const otherHits = new Map();

function bump(map, key, id) {
  let rec = map.get(key);
  if (!rec) {
    rec = { n: 0, ids: new Set() };
    map.set(key, rec);
  }
  rec.n++;
  rec.ids.add(id);
}

const ids = fs.existsSync(LIB)
  ? fs.readdirSync(LIB).filter((d) => fs.existsSync(join(LIB, d, "scene.pkg")))
  : [];

let scripts = 0;
let wallpapers = 0;
for (const id of ids) {
  let raw;
  try {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(join(LIB, id, "scene.pkg"))));
    const e = getEntry(pkg, "scene.json");
    if (!e) continue;
    raw = JSON.parse(dec.decode(e).replace(/^\uFEFF/, ""));
  } catch {
    continue;
  }
  wallpapers++;
  const list = [];
  walkScripts(raw, list);
  scripts += list.length;
  for (const src of list) {
    for (const m of src.matchAll(/\bengine\.([A-Za-z_][\w]*)/g)) bump(engineHits, m[1], id);
    for (const m of src.matchAll(/\bthisScene\.([A-Za-z_][\w]*)/g)) bump(sceneHits, m[1], id);
    for (const m of src.matchAll(/\b(?:thisLayer|thisObject)\.([A-Za-z_][\w]*)\s*\(/g)) bump(layerMethHits, m[1], id);
    for (const m of src.matchAll(/\binput\.([A-Za-z_][\w]*)/g)) bump(inputHits, m[1], id);
    for (const m of src.matchAll(/\b(wallpaperPlugin|chrome|browser|localStorage|sessionStorage|document\.title|navigator)\b/g)) {
      bump(otherHits, m[1], id);
    }
    for (const m of src.matchAll(/\bengine\[/g)) bump(engineHits, "[computed]", id);
    const meth = new RegExp(`(?<!\\bMath|\\bNumber|\\bconsole|\\bObject|\\bArray|\\bJSON)\\.(${OFFICIAL_VEC_METH.join("|")})\\s*\\(`, "g");
    for (const m of src.matchAll(meth)) bump(vecMethHits, m[1], id);
    for (const m of src.matchAll(/\b(Vec2|Vec3|Vec4|Mat3|Mat4)\b(\.\w+|\s*\()?/g)) {
      bump(classHits, m[1] + (m[2] ? (m[2].startsWith(".") ? m[2] : "()") : ""), id);
    }
  }
}

function dump(title, map, known) {
  const rows = [...map.entries()].sort((a, b) => b[1].n - a[1].n);
  console.log(`\n## ${title}`);
  for (const [k, rec] of rows) {
    const miss = known && !known.has(k) ? "  ← 未实现" : "";
    const sample = [...rec.ids].slice(0, 5).join(",");
    console.log(`  ${k.padEnd(28)} ${String(rec.n).padStart(5)} 处 / ${rec.ids.size} 张  ${sample}${miss}`);
  }
}

console.log(`扫描 ${wallpapers} 张场景 / ${scripts} 段脚本（库 ${LIB}）`);
dump("engine.*", engineHits, KNOWN_ENGINE);
dump("thisScene.*", sceneHits, KNOWN_SCENE);
dump("thisLayer/thisObject.meth()", layerMethHits, KNOWN_LAYER_METH);
dump("input.*", inputHits, KNOWN_INPUT);
dump("其它宿主符号", otherHits, new Set());
dump("向量/矩阵方法 .meth()（含 WEMath.mix 等同名调用，需人工甄别）", vecMethHits, null);
dump("向量/矩阵类引用", classHits, null);
