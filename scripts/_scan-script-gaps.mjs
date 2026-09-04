#!/usr/bin/env node
/**
 * 全库扫 scene.json 脚本里的 API 引用，对照沙箱已实现面，列出待补清单。
 * 一次性排查脚本，不进 pnpm check。
 */
import fs from "node:fs";
import { join } from "node:path";
import { LIB, dec } from "./lib/verify-kit.mjs";

function parsePkg(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magicLen = dv.getUint32(0, true);
  let magic = "";
  for (let i = 4; i < 4 + magicLen; i++) magic += String.fromCharCode(buf[i]);
  if (!magic.startsWith("PKGV")) throw new Error("不是 scene.pkg");
  const count = dv.getUint32(4 + magicLen, true);
  let p = 4 + magicLen + 4;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint32(p, true);
    p += 4;
    const name = dec.decode(buf.subarray(p, p + nameLen));
    p += nameLen;
    const offset = dv.getUint32(p, true);
    p += 4;
    const size = dv.getUint32(p, true);
    p += 4;
    entries.push({ name, offset, size });
  }
  return { entries, dataStart: p, buf };
}
function getEntry(pkg, name) {
  const e = pkg.entries.find((x) => x.name === name);
  if (!e) return null;
  return pkg.buf.subarray(pkg.dataStart + e.offset, pkg.dataStart + e.offset + e.size);
}

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
