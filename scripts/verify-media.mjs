#!/usr/bin/env node
/**
 * WE 媒体集成 API 的离线校验（不依赖浏览器 / WebGL / 系统媒体会话）。
 *
 * 覆盖：
 *   1. 模拟媒体源（render/media.js）：确定性、周期、三种播放态齐全、
 *      曲目轮换、进度单调、歌词行跟随时间戳；
 *   2. 颜色必须是 **Vec3 实例**（语料脚本会 `.subtract().multiply().add()` 链式调用，
 *      给数组或字符串会 TypeError 熔断整个脚本）；
 *   3. diffMediaEvents 的事件语义：**只在变化时派发**，首次派发全量；
 *   4. 沙箱出口：两个沙箱（evalTextScript / evalObjectScript）都要能收媒体回调，
 *      MediaPlaybackEvent 枚举可用，纯回调脚本（无 update）不被门禁丢弃；
 *   5. 真实壁纸语料回归：把本机库里所有挂媒体回调的脚本抽出来，
 *      逐个喂真实事件，断言不熔断、且能观察到输出随事件变化；
 *   6. 图层声音 / 视频纹理：getVideoTexture 不得返回 null，thisLayer.play
 *      必须打到 soundCtl；startsilent 层挂载后不得自动 play。
 *
 * 用法：node scripts/verify-media.mjs
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker } from "./lib/verify-kit.mjs";
const {
  MEDIA_PLAYBACK,
  createSimulatedMedia,
  diffMediaEvents,
  cloneMediaSnapshot,
  renderThumbnail,
  mediaVec3,
} = await imp("renderer/vendor/we-scene/render/media.js");
const { createSimulatedWindowTitle, createSimulatedSystem } = await imp("renderer/vendor/we-scene/render/system.js");
const { evalTextScript, evalObjectScript, makeCursorEventVec } = await imp("renderer/vendor/we-scene/render/text.js");
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");
const { parseScene } = await imp("renderer/vendor/we-scene/scene/parse.js");

const { check, errors } = createChecker();

// ---------- 1. 模拟媒体源 ----------
{
  const sim = createSimulatedMedia();
  const cycle = sim.cycle;
  check(cycle > 0, "播放列表周期应为正");

  const states = new Set();
  const titles = new Set();
  let lastTrack = -1;
  let posResets = 0;
  let badPos = 0;
  let lyricMismatch = 0;

  for (let t = 0; t < cycle + 5; t += 0.5) {
    sim.update(t);
    const s = sim.snapshot;
    states.add(s.state);
    if (s.title) titles.add(s.title);
    if (s.trackIndex !== lastTrack) {
      posResets++;
      lastTrack = s.trackIndex;
    }
    if (!(s.position >= 0 && s.position <= s.duration + 1e-6)) badPos++;
    // 歌词行必须与时间戳一致：找最后一个 ts <= position 的行
    if (Array.isArray(s.lyrics) && s.lyrics.length) {
      let want = -1;
      for (let i = 0; i < s.lyrics.length; i++) {
        const ts = Array.isArray(s.lyrics[i]) ? s.lyrics[i][0] : s.lyrics[i].time;
        if (ts <= s.position) want = i;
        else break;
      }
      if (want !== s.lyricIndex) lyricMismatch++;
    }
  }

  check(
    states.has(MEDIA_PLAYBACK.PLAYING),
    "一个周期内应出现 PLAYING 状态",
  );
  check(states.has(MEDIA_PLAYBACK.PAUSED), "一个周期内应出现 PAUSED 状态（暂停分支未被覆盖）");
  check(states.has(MEDIA_PLAYBACK.STOPPED), "一个周期内应出现 STOPPED 状态（曲间空隙）");
  check(titles.size >= 4, `一个周期内应轮换完整播放列表，实得 ${titles.size} 首`);
  check(badPos === 0, `进度应始终落在 [0, duration]，越界 ${badPos} 次`);
  check(lyricMismatch === 0, `歌词行与时间戳不符 ${lyricMismatch} 次`);

  // 确定性：同一时刻两次求值必须完全一致（暂停 / 回卷安全）
  const a = createSimulatedMedia();
  const b = createSimulatedMedia();
  let drift = 0;
  for (const t of [0, 13.5, 97, 210, 400, 777.25]) {
    a.update(t);
    b.update(t);
    const x = a.snapshot;
    const y = b.snapshot;
    if (
      x.title !== y.title ||
      x.state !== y.state ||
      Math.abs(x.position - y.position) > 1e-9 ||
      x.lyricIndex !== y.lyricIndex
    ) {
      drift++;
    }
  }
  check(drift === 0, `模拟源应为纯时间函数（同 t 同结果），${drift} 处不一致`);

  // 回卷：先跳到后面再回到前面，结果应与直接求值一致
  const fwd = createSimulatedMedia();
  fwd.update(500);
  fwd.update(42);
  const direct = createSimulatedMedia();
  direct.update(42);
  check(
    fwd.snapshot.title === direct.snapshot.title &&
      Math.abs(fwd.snapshot.position - direct.snapshot.position) < 1e-9,
    "回卷后应与直接求值一致（模拟源不应有隐藏累积状态）",
  );

  // 周期性：t 与 t+cycle 应等价
  const p1 = createSimulatedMedia();
  const p2 = createSimulatedMedia();
  p1.update(30);
  p2.update(30 + cycle);
  check(
    p1.snapshot.title === p2.snapshot.title &&
      Math.abs(p1.snapshot.position - p2.snapshot.position) < 1e-6,
    "模拟源应以 cycle 为周期",
  );
}

// ---------- 1b. 切歌 / 暂停控制面（模拟 provider，不是真系统媒体）----------
{
  const sim = createSimulatedMedia();
  sim.update(10);
  const first = sim.snapshot.title;
  const firstIdx = sim.snapshot.trackIndex;
  sim.skipNext();
  check(sim.snapshot.trackIndex !== firstIdx, `skipNext 应换曲，仍停在 ${firstIdx} ${sim.snapshot.title}`);
  check(sim.snapshot.title !== first, `skipNext 后歌名应变，仍是 ${first}`);
  check(sim.snapshot.position < 1, `skipNext 应落到下一首开头，position=${sim.snapshot.position}`);
  const mid = sim.snapshot.title;
  sim.skipPrevious();
  check(sim.snapshot.title === first, `skipPrevious 应回到上一首，实得 ${sim.snapshot.title} 期望 ${first}`);
  sim.pause();
  check(sim.snapshot.state === MEDIA_PLAYBACK.PAUSED, `pause 后 state 应为 PAUSED，实得 ${sim.snapshot.state}`);
  const pos = sim.snapshot.position;
  sim.update(10 + 30);
  check(sim.snapshot.title === first, "暂停后时间推进不应换歌");
  check(Math.abs(sim.snapshot.position - pos) < 1e-9, "暂停后进度应冻结");
  sim.play();
  check(sim.snapshot.state !== MEDIA_PLAYBACK.PAUSED, "play 后不应再保持用户暂停");
  sim.playPause();
  check(sim.snapshot.state === MEDIA_PLAYBACK.PAUSED, "playPause 应从播放切到暂停");
  void mid;
}

// ---------- 1c. 窗口标题模拟源（浏览器标签名的可替换接口）----------
{
  const w = createSimulatedWindowTitle();
  check(typeof w.snapshot.title === "string" && w.snapshot.title.length > 0, "窗口标题快照应有 title");
  const a = createSimulatedWindowTitle();
  const b = createSimulatedWindowTitle();
  a.update(0);
  b.update(0);
  check(a.snapshot.title === b.snapshot.title, "窗口标题应为纯时间函数（同 t 同结果）");
  a.update(0);
  const t0 = a.snapshot.title;
  a.update(w.hold + 0.1);
  check(a.snapshot.title !== t0, "超过 hold 后应换到下一个模拟标签");
  const sys = createSimulatedSystem();
  check(sys.media && typeof sys.media.skipNext === "function", "createSimulatedSystem 应带媒体控制面");
  check(sys.windowTitle && sys.windowTitle.snapshot, "createSimulatedSystem 应带窗口标题源");
  sys.shortcuts.openUserShortcut("newproperty13");
  check(sys.shortcuts.last.name === "newproperty13", "openUserShortcut 应记下属性名");
}

// ---------- 2. 颜色必须是 Vec3 实例 ----------
{
  const sim = createSimulatedMedia();
  sim.update(30);
  const s = sim.snapshot;
  const colorKeys = [
    "primaryColor",
    "secondaryColor",
    "tertiaryColor",
    "textColor",
    "highContrastColor",
  ];
  for (const k of colorKeys) {
    const c = s[k];
    check(c && typeof c === "object", `${k} 应为对象`);
    if (!c || typeof c !== "object") continue;
    // 语料脚本的标准写法：newColor.subtract(oldColor).multiply(f).add(oldColor)
    // 缺任何一个方法都会 TypeError 熔断整个脚本（makeCursorEventVec 踩过同款坑）
    for (const m of ["add", "subtract", "multiply", "divide", "copy"]) {
      check(typeof c[m] === "function", `${k} 缺方法 ${m}（语料脚本会链式调用）`);
    }
    check(
      Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.z),
      `${k} 的 xyz 应为有限数`,
    );
  }
  // 链式调用的数值正确性
  const A = mediaVec3(1, 2, 3);
  const B = mediaVec3(0.5, 0.5, 0.5);
  const r = A.subtract(B).multiply(2).add(B);
  check(
    Math.abs(r.x - 1.5) < 1e-9 && Math.abs(r.y - 3.5) < 1e-9 && Math.abs(r.z - 5.5) < 1e-9,
    `Vec3 链式运算结果错误：${JSON.stringify(r.toArray())}`,
  );
  // 链式调用不应就地改写源对象（语料把 oldColor 存着跨帧复用；
  // 就地改写会让「上一次的颜色」被悄悄污染，淡入淡出永远算不对）。
  // 四个运算符都要查：只测其中一个，另外三个改成就地写也照样全绿。
  const src0 = mediaVec3(1, 2, 3);
  const arg0 = mediaVec3(0.5, 0.5, 0.5);
  const snapshotOf = (v) => `${v.x},${v.y},${v.z}`;
  for (const [name, call] of [
    ["add", (v) => v.add(arg0)],
    ["subtract", (v) => v.subtract(arg0)],
    ["multiply", (v) => v.multiply(2)],
    ["multiply(vec)", (v) => v.multiply(arg0)],
    ["divide", (v) => v.divide(2)],
    ["copy", (v) => v.copy()],
  ]) {
    const v = mediaVec3(1, 2, 3);
    const beforeSelf = snapshotOf(v);
    const beforeArg = snapshotOf(arg0);
    const out = call(v);
    check(out !== v, `Vec3.${name} 应返回新实例而非 this`);
    check(snapshotOf(v) === beforeSelf, `Vec3.${name} 不应就地改写源对象`);
    check(snapshotOf(arg0) === beforeArg, `Vec3.${name} 不应改写入参`);
  }
  check(snapshotOf(src0) === "1,2,3", "Vec3 运算不应就地改写源对象");

  // 封面：程序化生成的 RGBA 位图
  const th = renderThumbnail(
    { colors: { primary: [1, 0, 0], secondary: [0, 0, 1], tertiary: [0, 1, 0] }, title: "x" },
    64,
  );
  check(th && th.width === 64 && th.height === 64, "封面尺寸应为请求的 size");
  check(th && th.rgba && th.rgba.length === 64 * 64 * 4, "封面应为 RGBA8 位图");
  if (th && th.rgba) {
    let nonZero = 0;
    for (let i = 0; i < th.rgba.length; i += 4) if (th.rgba[i] || th.rgba[i + 1] || th.rgba[i + 2]) nonZero++;
    check(nonZero > 64 * 64 * 0.5, "封面不应大面积全黑");
  }
}

// ---------- 3. diffMediaEvents 的事件语义 ----------
{
  const sim = createSimulatedMedia();
  sim.update(30);
  const first = diffMediaEvents(null, sim.snapshot);
  const names = first.map((e) => e.name);
  for (const want of [
    "mediaStatusChanged",
    "mediaPropertiesChanged",
    "mediaThumbnailChanged",
    "mediaPlaybackChanged",
    "mediaTimelineChanged",
    "mediaLyricsChanged",
  ]) {
    check(names.includes(want), `首次派发应包含 ${want}，实得 ${JSON.stringify(names)}`);
  }

  // 同一快照重复 diff 应**一个事件都不产生**：语料里
  // mediaThumbnailChanged 常写 `anim.stop(); anim.play();`，每帧广播会让动画
  // 永远卡在第 0 帧重放。
  const snap = cloneMediaSnapshot(sim.snapshot);
  const again = diffMediaEvents(snap, sim.snapshot);
  check(again.length === 0, `未变化时不应派发事件，实得 ${JSON.stringify(again.map((e) => e.name))}`);

  // 只改标题 ⇒ 只出 Properties（外加同帧的 timeline 不动）
  const onlyTitle = { ...snap, title: snap.title + "!" };
  const evTitle = diffMediaEvents(snap, onlyTitle).map((e) => e.name);
  check(
    evTitle.includes("mediaPropertiesChanged"),
    "标题变化应派发 mediaPropertiesChanged",
  );
  check(
    !evTitle.includes("mediaPlaybackChanged"),
    `只改标题不应派发 mediaPlaybackChanged，实得 ${JSON.stringify(evTitle)}`,
  );

  // 只改播放态 ⇒ 只出 Playback
  const onlyState = { ...snap, state: snap.state === 1 ? 2 : 1 };
  const evState = diffMediaEvents(snap, onlyState).map((e) => e.name);
  check(evState.includes("mediaPlaybackChanged"), "播放态变化应派发 mediaPlaybackChanged");
  check(
    !evState.includes("mediaPropertiesChanged"),
    `只改播放态不应派发 mediaPropertiesChanged，实得 ${JSON.stringify(evState)}`,
  );

  // 播放态事件必须带 state，且取值在枚举内
  const pb = diffMediaEvents(null, sim.snapshot).find((e) => e.name === "mediaPlaybackChanged");
  check(
    pb && [0, 1, 2].includes(pb.event.state),
    `mediaPlaybackChanged.state 应在 {0,1,2}，实得 ${pb && pb.event.state}`,
  );
  // 缩略图事件必须带 Vec3 颜色（脚本直接拿去链式运算）
  const th = diffMediaEvents(null, sim.snapshot).find((e) => e.name === "mediaThumbnailChanged");
  check(
    th && th.event.primaryColor && typeof th.event.primaryColor.subtract === "function",
    "mediaThumbnailChanged.primaryColor 应为 Vec3 实例",
  );
  // 歌词事件（自定义扩展）应带行文本与索引
  const ly = diffMediaEvents(null, sim.snapshot).find((e) => e.name === "mediaLyricsChanged");
  check(ly && typeof ly.event.line === "string", "mediaLyricsChanged 应带 line 字符串");
}

// ---------- 4. 沙箱出口 ----------
{
  // 纯媒体回调脚本（**没有 update**）：门禁必须放行，否则 46+101 处
  // effect 上的纯回调脚本会被整片丢弃（README 记过同型错误）。
  const pureCallback = `
    'use strict';
    var lastTitle = '';
    var lastState = -1;
    export function mediaPropertiesChanged(event) { lastTitle = event.title; }
    export function mediaPlaybackChanged(event) { lastState = event.state; }
    export function probe() { return lastTitle + '|' + lastState; }
  `;
  for (const [label, fn] of [
    ["evalTextScript", evalTextScript],
    ["evalObjectScript", evalObjectScript],
  ]) {
    let sb = null;
    try {
      sb = fn(pureCallback, null, {});
    } catch (e) {
      errors.push(`${label} 求值纯回调脚本抛错: ${e && e.message}`);
      continue;
    }
    check(!!sb, `${label} 不应丢弃纯媒体回调脚本（没有 update 也要保留）`);
    if (!sb) continue;
    check(sb.hasMediaHook === true, `${label} 应标记 hasMediaHook`);
    check(typeof sb.callMedia === "function", `${label} 应导出 callMedia`);
    if (typeof sb.callMedia !== "function") continue;
    sb.callMedia("mediaPropertiesChanged", { title: "夜航星" });
    sb.callMedia("mediaPlaybackChanged", { state: 1 });
    // 回调确实改到了脚本内部状态
    const got = sb.exports && typeof sb.exports.probe === "function" ? sb.exports.probe() : null;
    if (got !== null) {
      check(got === "夜航星|1", `${label} 媒体回调未写入脚本状态，实得 ${got}`);
    }
  }

  // MediaPlaybackEvent 枚举必须注入沙箱：全库 149 处语料裸用
  // `MediaPlaybackEvent.PLAYBACK_PLAYING`（实测成员名带 PLAYBACK_ 前缀：
  // STOPPED 73 / PLAYING 55 / PAUSED 21），不注入会 ReferenceError 熔断整个脚本。
  const usesEnum = `
    'use strict';
    var seen = -1;
    export function mediaPlaybackChanged(event) {
      if (event.state == MediaPlaybackEvent.PLAYBACK_PLAYING) seen = 1;
      else if (event.state == MediaPlaybackEvent.PLAYBACK_PAUSED) seen = 2;
      else if (event.state == MediaPlaybackEvent.PLAYBACK_STOPPED) seen = 0;
      else seen = -9;
    }
    export function update(value) { return seen; }
  `;
  for (const [label, fn] of [
    ["evalTextScript", evalTextScript],
    ["evalObjectScript", evalObjectScript],
  ]) {
    const sb = fn(usesEnum, null, {});
    check(!!sb, `${label} 应能求值使用 MediaPlaybackEvent 的脚本`);
    if (!sb) continue;
    sb.callMedia("mediaPlaybackChanged", { state: 1 });
    // 注意：evalTextScript 的 update 用于**文字内容**，返回值会被字符串化；
    // evalObjectScript 保留原始类型。这里比较数值而非类型，两者都能覆盖。
    const v = Number(sb.callUpdate(0));
    check(v === 1, `${label} 中 MediaPlaybackEvent.PLAYBACK_PLAYING 未生效，update 返回 ${v}`);
    sb.callMedia("mediaPlaybackChanged", { state: 2 });
    check(
      Number(sb.callUpdate(0)) === 2,
      `${label} 中 MediaPlaybackEvent.PLAYBACK_PAUSED 未生效`,
    );
    // 未知枚举名会让脚本走 else 分支返回 -9 —— 上面两条已排除这种情况
    sb.callMedia("mediaPlaybackChanged", { state: 0 });
    check(
      Number(sb.callUpdate(0)) === 0,
      `${label} 中 MediaPlaybackEvent.PLAYBACK_STOPPED 未生效`,
    );
  }

  // 顶层同名 var 不应把脚本炸掉（SANDBOX_PARAM_NAMES 必须收录 MediaPlaybackEvent）
  const shadow = `
    'use strict';
    var MediaPlaybackEvent = { STOPPED: 0, PLAYING: 1, PAUSED: 2 };
    export function mediaPlaybackChanged(event) { }
    export function update(value) { return 7; }
  `;
  const sh = evalObjectScript(shadow, null, {});
  check(!!sh, "脚本顶层重声明 MediaPlaybackEvent 不应导致整段 SyntaxError");
  if (sh) check(sh.callUpdate(0) === 7, "重声明后脚本仍应正常工作");

  // 回调抛错不应冒泡（沙箱有三振熔断）
  const boom = `
    'use strict';
    export function mediaPlaybackChanged(event) { throw new Error('boom'); }
    export function update(value) { return 1; }
  `;
  const bs = evalObjectScript(boom, null, {});
  let threw = false;
  try {
    if (bs) for (let i = 0; i < 5; i++) bs.callMedia("mediaPlaybackChanged", { state: 1 });
  } catch {
    threw = true;
  }
  check(!threw, "媒体回调抛错不应冒泡到宿主");

  // 只挂 cursor 钩子的脚本不应被误标成 hasMediaHook
  const cursorOnly = `
    'use strict';
    export function cursorMove(event) { }
    export function update(value) { return value; }
  `;
  const cs = evalObjectScript(cursorOnly, null, {});
  check(cs && !cs.hasMediaHook, "只有 cursor 回调的脚本不应被标记 hasMediaHook");
}

// ---------- 5. 真实壁纸语料回归 ----------
{
  const MEDIA_NAMES = [
    "mediaPropertiesChanged",
    "mediaThumbnailChanged",
    "mediaPlaybackChanged",
    "mediaTimelineChanged",
    "mediaStatusChanged",
  ];
  const sim = createSimulatedMedia();
  sim.update(30);
  const events = diffMediaEvents(null, sim.snapshot);
  sim.update(30 + sim.cycle / 3);
  const events2 = diffMediaEvents(null, sim.snapshot);

  let scripts = 0;
  let wallpapers = 0;
  let compiled = 0;
  let hooked = 0;
  let crashed = 0;
  let dynamic = 0;
  let withUpdate = 0;
  let skipped = 0;

  let ids = [];
  try {
    ids = fs.readdirSync(LIB);
  } catch {
    ids = [];
  }
  for (const id of ids) {
    const pkgPath = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) continue;
    let scene;
    try {
      const parsed = parsePkg(fs.readFileSync(pkgPath));
      const e = getEntry(parsed, "scene.json");
      if (!e) continue;
      scene = JSON.parse(Buffer.from(e).toString("utf8"));
    } catch {
      continue;
    }
    let hit = false;
    // 通用遍历：媒体回调挂在对象字段、效果常量、effect.visible、文字层等多处，
    // 按固定路径找会漏掉大半。
    const seen = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const x of node) walk(x);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "script" && typeof v === "string" && MEDIA_NAMES.some((n) => v.includes(n))) {
          if (seen.has(v)) continue;
          seen.add(v);
          // 语料里有两类**本就不该求值成功**的脚本，不能算失败：
          //   a) 整段被注释掉（作者留的历史版本）—— 没有任何 export，
          //      2902406982 有 3 处，命中的只是注释文本里的回调名；
          //   b) 混淆过的代码（3078285611 是 _0x 系列的 obfuscator 产物），
          //      沙箱按 ES module 语法解析必然失败。
          // 判据：源码里存在真正的 `export function <媒体回调名>` 才计入统计。
          const hasRealExport = MEDIA_NAMES.some((n) =>
            new RegExp(`^\\s*export\\s+function\\s+${n}\\s*\\(`, "m").test(v),
          );
          if (!hasRealExport) {
            skipped++;
            continue;
          }
          hit = true;
          scripts++;
          let sb = null;
          try {
            sb = evalObjectScript(v, node.scriptproperties || node.scriptProperties || null, {});
          } catch {
            sb = null;
          }
          if (!sb) {
            crashed++;
            continue;
          }
          compiled++;
          if (sb.hasMediaHook) hooked++;
          if (sb.hasUpdate) withUpdate++;
          // WE 挂载顺序：init(字段当前值) → applyUserProperties → 逐帧 update。
          // 3791163858 悬停缩放在 applyUserProperties 里 `initScale.multiply(hoScale)`，
          // 不先 init 就会把「沙箱缺 Vec3 方法」和「verifier 没走完生命周期」混在一起。
          try {
            sb.init({ x: 1, y: 1, z: 1 });
            sb.applyUserProperties({});
          } catch {
            /* init 抛错由 errCount 记录，下面 disabled 检查会抓到熔断 */
          }
          // 喂两组真实事件，看 update 的输出是否随之变化
          const readOut = () => {
            if (!sb.hasUpdate) return null;
            try {
              const r = sb.callUpdate({ x: 1, y: 1, z: 1 });
              if (r === null || r === undefined) return null;
              if (typeof r === "number") return String(r.toFixed(4));
              if (typeof r === "object")
                return `${Number(r.x).toFixed(4)},${Number(r.y).toFixed(4)},${Number(r.z).toFixed(4)}`;
              return String(r);
            } catch {
              return "ERR";
            }
          };
          try {
            for (const { name, event } of events) sb.callMedia(name, event);
            const o1 = readOut();
            for (const { name, event } of events2) sb.callMedia(name, event);
            const o2 = readOut();
            if (o1 !== null && o2 !== null && o1 !== o2) dynamic++;
          } catch {
            crashed++;
          }
          if (sb.disabled) crashed++;
          continue;
        }
        walk(v);
      }
    };
    walk(scene.objects || []);
    if (hit) wallpapers++;
  }

  if (scripts > 0) {
    check(crashed === 0, `真实语料中 ${crashed}/${scripts} 个媒体脚本熔断或求值失败`);
    check(
      compiled === scripts,
      `真实语料应全部可求值，${scripts - compiled}/${scripts} 失败`,
    );
    check(
      hooked === scripts,
      `所有含媒体回调的脚本都应被标记 hasMediaHook，实得 ${hooked}/${scripts}`,
    );
    // 至少一部分脚本的输出要随事件变化 —— 否则说明回调根本没写进脚本状态
    check(
      dynamic > 0,
      `真实语料中无一脚本的输出随媒体事件变化（${withUpdate} 个带 update）—— 回调可能没派发进去`,
    );
    console.log(
      `  真实语料：${scripts} 个媒体脚本 / ${wallpapers} 张壁纸` +
        `（可求值 ${compiled}，带 update ${withUpdate}，输出随事件变化 ${dynamic}，` +
        `跳过注释/混淆 ${skipped}）`,
    );
  } else {
    console.log("  真实语料：未找到壁纸库，跳过回归");
  }
}

// ---------- 6. 图层声音 / 视频纹理控制 ----------
{
  const spyCtl = () => {
    const log = [];
    const ctl = {
      log,
      _playing: false,
      play() {
        log.push("play");
        ctl._playing = true;
      },
      pause() {
        log.push("pause");
        ctl._playing = false;
      },
      stop() {
        log.push("stop");
        ctl._playing = false;
      },
      isPlaying: () => ctl._playing,
      duration: () => 12,
      getCurrentTime: () => 0,
      setCurrentTime() {},
      getRate: () => 1,
      setRate() {},
      getLoop: () => true,
      setLoop() {},
      addEndedCallback() {},
      getVolume: () => 0.8,
      setVolume() {},
    };
    return ctl;
  };

  // getVideoTexture 永不 null；play/stop 打到 layer.videoCtl
  {
    const layer = { name: "健康壁纸", visible: false, videoCtl: spyCtl() };
    const sb = evalObjectScript(
      "export function init() {\n" +
        "  var v = thisLayer.getVideoTexture();\n" +
        "  v.stop();\n" +
        "  v.play();\n" +
        "}\n" +
        "export function update(value) { return value; }\n",
      {},
      { layer },
    );
    check(!!sb, "getVideoTexture 单元沙箱应能构建");
    if (sb) {
      sb.init();
      check(sb.errCount === 0, `getVideoTexture().stop 不应熔断，errCount=${sb.errCount}`);
      check(
        layer.videoCtl.log.join(",") === "stop,play",
        `getVideoTexture 应转发 stop/play，实得 ${layer.videoCtl.log.join(",")}`,
      );
      const again = evalObjectScript(
        "export function init() { shared.handle = thisLayer.getVideoTexture(); }\n" +
          "export function update(value) { return thisLayer.getVideoTexture() === shared.handle; }\n",
        {},
        { layer, shared: {} },
      );
      again.init();
      check(again.callUpdate(true) === true, "同一图层多次 getVideoTexture 应返回同一句柄");
    }
  }

  // thisScene.getLayer(name).play() 打到声音层（2887099508 / 3292361861 点耳朵播语音）
  {
    const voice = {
      name: "语言1",
      soundCtl: spyCtl(),
      soundprops: { startsilent: true, volume: 1, playbackmode: "single" },
    };
    const btn = { name: "1语言" };
    const sb = evalObjectScript(
      "export function cursorClick() { thisScene.getLayer('语言1').play(); }\n",
      {},
      { layer: btn, getSceneLayer: (n) => (n === "语言1" ? voice : null) },
    );
    check(!!sb && sb.hasCursorHook, "声音层 play 沙箱应保留 cursorClick");
    if (sb) {
      sb.callCursor("cursorClick", makeCursorEventVec(0, 0, 0));
      check(
        voice.soundCtl.log.join(",") === "play",
        `getLayer('语言1').play 应打到 soundCtl，实得 ${voice.soundCtl.log.join(",")}`,
      );
    }
  }

  // ISoundLayer.isPlaying() 是方法（官方文档）；属性读走 valueOf，两种写法都不炸
  {
    const ctl = spyCtl();
    const st = evalObjectScript(
      "export function update(value) {\n" +
        "  return thisLayer.isPlaying() ? 1 : 0;\n" +
        "}\n",
      {},
      { layer: { soundCtl: ctl } },
    );
    check(st.callUpdate(0) === 0, `未在播 isPlaying() 应为 false，实得 ${st.callUpdate(0)}`);
    ctl.play();
    check(st.callUpdate(0) === 1, `在播 isPlaying() 应为 true，实得 ${st.callUpdate(0)}`);
  }

  // 宿主源码：startsilent 不得一律 au.play；getVideoTexture 不得恒 null
  {
    const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
    const textSrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/text.js"), "utf8");
    check(
      /soundprops\?\.startsilent/.test(mount),
      "scene-mount 必须按 startsilent 决定是否自动 play（2887099508 有 10 层静音起步）",
    );
    check(
      !/延迟启动（startsilent 或默认不立即响）[\s\S]{0,40}au\.play\(\)/.test(mount),
      "scene-mount 不得在注释「延迟启动」后仍一律 au.play（旧 stub 就是这样）",
    );
    check(
      !/getVideoTexture:\s*\(\)\s*=>\s*null/.test(textSrc),
      "getVideoTexture 不得恒返回 null（3292361861 init 里 video.stop() 会熔断）",
    );
    check(
      /AbortError/.test(mount),
      "scene-mount 必须提到 AbortError（切壁纸/预热打断 play 不是解码失败）",
    );
  }

  // 3292361861：真实脚本 init 里 getVideoTexture().stop()，不得熔断
  {
    const id = "3292361861";
    const pkgPath = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) {
      console.log("  （跳过 3292361861 语料：本机无此壁纸）");
    } else {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const sj = JSON.parse(Buffer.from(getEntry(pkg, "scene.json")).toString("utf8").replace(/^\uFEFF/, ""));
      const pjPath = join(LIB, id, "project.json");
      const pj = fs.existsSync(pjPath) ? JSON.parse(fs.readFileSync(pjPath, "utf8")) : null;
      const scene = parseScene(sj, pj);
      let hit = 0;
      let stopped = 0;
      let melted = 0;
      for (const layer of scene.layers) {
        const scripts = layer.objectScripts;
        if (!scripts) continue;
        for (const def of Object.values(scripts)) {
          if (!def || typeof def.script !== "string" || !def.script.includes("getVideoTexture")) continue;
          hit++;
          layer.videoCtl = spyCtl();
          const errs = [];
          const sb = evalObjectScript(def.script, def.scriptproperties || {}, {
            layer,
            userProperties: {},
            getSceneLayer: (n) => scene.layers.find((l) => l.name === n) || null,
            onError: (e) => errs.push(String(e && e.message)),
          });
          if (!sb) {
            melted++;
            continue;
          }
          sb.init(true);
          if (sb.errCount > 0 || errs.length) melted++;
          if (layer.videoCtl.log.includes("stop") || layer.videoCtl.log.includes("pause")) stopped++;
        }
      }
      check(hit > 0, "3292361861 应至少有一处 getVideoTexture 脚本（用例过期）");
      check(melted === 0, `3292361861 getVideoTexture().stop 熔断 ${melted}/${hit}：${"init TypeError"}`);
      check(stopped > 0, "3292361861 init 必须真正 stop/pause 视频（否则画面一加载就在播）");
    }
  }

  // 2887099508：startsilent 层数 + 点击交互会 play 声音/视频
  {
    const id = "2887099508";
    const pkgPath = join(LIB, id, "scene.pkg");
    if (!fs.existsSync(pkgPath)) {
      console.log("  （跳过 2887099508 语料：本机无此壁纸）");
    } else {
      const pkg = parsePkg(fs.readFileSync(pkgPath));
      const sj = JSON.parse(Buffer.from(getEntry(pkg, "scene.json")).toString("utf8").replace(/^\uFEFF/, ""));
      const pjPath = join(LIB, id, "project.json");
      const pj = fs.existsSync(pjPath) ? JSON.parse(fs.readFileSync(pjPath, "utf8")) : null;
      const scene = parseScene(sj, pj);
      const silent = scene.layers.filter((l) => l.sound && l.sound.length && l.soundprops && l.soundprops.startsilent);
      check(silent.length >= 8, `2887099508 应有约 10 层 startsilent 声音，实得 ${silent.length}`);
      const byName = new Map(scene.layers.map((l) => [l.name, l]));
      for (const l of scene.layers) {
        if (l.sound && l.sound.length) l.soundCtl = spyCtl();
      }
      const health = byName.get("健康壁纸");
      if (health) health.videoCtl = spyCtl();
      const shared = {};
      const ev = makeCursorEventVec(3000, 1700, 0);
      const userProps = {};
      for (const [k, v] of Object.entries(scene.properties || {})) {
        if (v && typeof v === "object" && "value" in v) userProps[k] = v.value;
      }
      for (const layer of scene.layers) {
        const scripts = layer.objectScripts;
        if (!scripts) continue;
        for (const def of Object.values(scripts)) {
          if (!def || typeof def.script !== "string") continue;
          const sb = evalObjectScript(def.script, def.scriptproperties || {}, {
            layer,
            shared,
            userProperties: userProps,
            getSceneLayer: (n) => byName.get(String(n)) || null,
            onError: () => {},
          });
          if (!sb) continue;
          try {
            sb.init(true);
            sb.applyUserProperties(userProps);
            sb.applyUserProperties({ ...userProps, defaultbgm: 1 });
          } catch {
            /* 混淆反调试脚本可能主动炸掉，不算本项失败 */
          }
          if (!sb.hasCursorHook) continue;
          for (const hook of ["cursorClick", "cursorEnter", "cursorDown"]) {
            try {
              sb.callCursor(hook, ev);
            } catch {
              /* 忽略 */
            }
          }
        }
      }
      const soundPlays = scene.layers.filter(
        (l) => l.soundCtl && l.soundCtl.log && l.soundCtl.log.includes("play"),
      ).map((l) => l.name);
      const videoOps = health && health.videoCtl ? health.videoCtl.log : [];
      check(
        soundPlays.length > 0 || videoOps.length > 0,
        `2887099508 点击交互应触发声音 play 或视频控制，声音=${soundPlays.join(",") || "无"} 视频=${videoOps.join(",") || "无"}`,
      );
    }
  }
}

if (errors.length) {
  console.error(`verify-media: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-media: all checks passed");
