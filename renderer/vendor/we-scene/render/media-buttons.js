// [we-scene patch] 媒体组件按钮点击 → 播放控制的推断 + 控制源选择（3794460976）
//
// 现象：「蓝屏大肥鱼——deepseek鲸鱼娘」（3794460976）左上角 Now Playing 组件的
// ▶ / ⏮ / ⏭ 按钮点了没反应 —— 元数据/封面/进度/播放暂停图标全对，唯独控制是死的。
//
// 根因（内容级缺陷，同组件三张壁纸同病）：
//   - 组件（Media Info. Collection）按钮脚本是 `cursorClick →
//     engine.openUserShortcut("newproperty12/13/14")`。WE 语义 = 执行用户在
//     **usershortcut 属性**里绑定的快捷方式：同组件的 3582294895 / 3584071721
//     这三个属性确实是 usershortcut（默认空绑定），而本壁纸作者把它们建成
//     **bool:true** —— 没有绑定可执行，WE 里同样是死路；
//   - 暂停图标的 cursorClick 在包里**被作者注释掉**，播放中可见的图标连脚本都
//     不会派发，只靠 openUserShortcut 这条路永远救不回暂停；
//   - 渲染器侧 openUserShortcut 只记一笔诊断（快捷方式执行器没有宿主实现）。
//
// 产品决定（2026-09-29，「音乐控制接入，媒体桥接正式接入 控制反转」）：
//   这类「媒体按钮」的点击直接推断成播放控制；**本模块只产出动作名**，执行走
//   scene-mount 注入的 mediaControl（控制反转）—— 后端由宿主选：测试台
//   liveSystem → /api/system/media-control → media-bridge；宿主 setMedia 源
//   自带控制方法时优先用它；都没有才回落显示源（壁纸音频 / 模拟）。
//
// 判据：verify-media「11. 媒体按钮点击 → 播放控制」—— 真实语料 4 动作 +
// 同组件跨壁纸 + 负例 + 两处接线守卫（改坏即红）。

/** 能产动作的按钮图层名（Media Info. Collection 组件全库只有这四种写法） */
const BUTTON_NAME = /^(player(play|pause)bold\d*|(previous|next)\s*song)$/i;

/** 控制方法面：宿主注入源可以只给元数据（没有这些方法就不该被选为控制源） */
const CONTROL_METHODS = ["play", "pause", "playPause", "skipNext", "skipPrevious"];

export function hasMediaControl(driver) {
  if (!driver) return false;
  for (const k of CONTROL_METHODS) if (typeof driver[k] === "function") return true;
  return false;
}

/**
 * 图层名 + 组件锚点 → 播放控制动作名；认不出返回 null。
 *
 * 两道闸门（缺一不可，防全库误伤）：
 *   1. 图层名命中组件按钮的固定命名（playerplaybold2 / previous song …）——
 *      全库 144 个 play/pause/next/prev 关键词图层里只有本组件这四种写法；
 *      自带播放列表的壁纸（2847470774 的 playerplay/playerback/playerskip 等）
 *      名字不在模式内，绝不能被劫持去控系统媒体。
 *   2. 该层脚本源里出现 `openUserShortcut` —— 这是组件的点击契约（暂停图标的
 *      调用虽被注释，字面仍在源里，恰好把「无活动脚本的暂停图标」也锚进来）。
 *
 * @param {string} name 图层名
 * @param {string[]} scripts 该层全部脚本源（含被注释的）
 * @returns {"play"|"pause"|"skipNext"|"skipPrevious"|null}
 */
export function mediaButtonAction(name, scripts) {
  if (typeof name !== "string" || !BUTTON_NAME.test(name)) return null;
  let anchored = false;
  for (const s of scripts || []) {
    if (typeof s === "string" && s.indexOf("openUserShortcut") >= 0) {
      anchored = true;
      break;
    }
  }
  if (!anchored) return null;
  const n = name.toLowerCase();
  // 顺序敏感：PlayerPauseBold2 里含 "play"（Player…），pause 必须先判
  if (n.indexOf("pause") >= 0) return "pause";
  if (n.indexOf("play") >= 0) return "play";
  if (n.indexOf("previous") >= 0 || n.indexOf("prev") >= 0) return "skipPrevious";
  if (n.indexOf("next") >= 0) return "skipNext";
  return null;
}

/** 从 parse 后的图层收集全部脚本源（srcObject 任意深度的 .script） */
export function layerScriptSources(layer) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v);
      return;
    }
    for (const k of Object.keys(o)) {
      if (k === "script" && typeof o[k] === "string") out.push(o[k]);
      else walk(o[k]);
    }
  };
  walk(layer && layer.srcObject);
  return out;
}

/** 派发点一站式入口：图层 → 动作名（不认得返回 null） */
export function mediaButtonActionForLayer(layer) {
  if (!layer) return null;
  return mediaButtonAction(layer.name, layerScriptSources(layer));
}

/**
 * 控制源选择（与**显示源**分离）：显示按 hasMedia 排优先级（没在播不占驱动位，
 * 2388299037），但控制优先交给注入源本身 —— 没在播时点「播放」要能唤醒真实
 * 播放器（media-bridge / 宿主命令通道），而不是掉到模拟源去切模拟曲目。
 * 判据里钉死：**不得读 snapshot.hasMedia**（读了就退回显示语义，空播点播放
 * 又会去切模拟曲）。
 *
 * @param {*} live 测试台系统实况驱动（liveSystem → media-bridge），可为 null
 * @param {*} injected 宿主注入源（setMedia / MountOptions.media），可为 null
 * @param {*} display 显示源选择结果（currentMediaDriver()：壁纸音频 / 模拟兜底）
 */
export function pickControlDriver(live, injected, display) {
  if (hasMediaControl(live)) return live;
  if (hasMediaControl(injected)) return injected;
  return display || null;
}
