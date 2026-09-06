#!/usr/bin/env node
/**
 * WE 关键帧动画的离线校验（不依赖浏览器 / WebGL）。
 *
 * 覆盖：
 *   1. 贝塞尔求值核（sampleChannel）：端点、单调、水平切线、enabled:false 退化线性；
 *   2. wrapFrame 的三种 mode（single / loop / mirror）；
 *   3. 控制器语义：startpaused、单次结束回调只触发一次、负 rate 倒放、
 *      小数 fps、relative 叠加；
 *   4. 真实壁纸数据全量回归：把本机库里 126 处动画逐帧跑一遍，
 *      断言取值有限、落在关键帧值域内（贝塞尔手柄会外扩，留出裕量）、
 *      通道数与字段语义匹配。
 *
 * 用法：node scripts/verify-animation.mjs
 */
import fs from "node:fs";
import { join } from "node:path";

import { LIB, ROOT, imp, createChecker } from "./lib/verify-kit.mjs";
const { sampleChannel, wrapFrame, createAnimation, createNeutralAnimation } = await imp(
  "renderer/vendor/we-scene/render/animation.js",
);
const { parsePkg, getEntry } = await imp("renderer/vendor/we-scene/pkg/container.js");

const { check, errors } = createChecker();
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const kf = (frame, value, front, back) => ({
  frame,
  value,
  front: front || { enabled: false, x: 1, y: 0 },
  back: back || { enabled: false, x: 1, y: 0 },
  lockangle: true,
  locklength: true,
});

// ---------- 1. 贝塞尔求值核 ----------
{
  // 端点必须精确命中（否则整条动画会有半帧偏移）
  const keys = [kf(0, 10), kf(30, 40)];
  check(near(sampleChannel(keys, 0), 10), `端点 f=0 应为 10，实得 ${sampleChannel(keys, 0)}`);
  check(near(sampleChannel(keys, 30), 40), `端点 f=30 应为 40，实得 ${sampleChannel(keys, 30)}`);
  // 区间外钳制到端点（WE 的 length 常大于最后一帧，尾部是留白）。
  // 用**带手柄**的关键帧：enabled:false 时贝塞尔恰好也落在端点值上，
  // 那样即使删掉钳制短路也测不出来（实测过，是个假守卫）。
  const clampKeys = [
    kf(10, 100, { enabled: true, x: 1, y: 40 }, { enabled: true, x: -1, y: -30 }),
    kf(40, 200, { enabled: true, x: 1, y: 25 }, { enabled: true, x: -1, y: -55 }),
  ];
  check(near(sampleChannel(clampKeys, 10), 100), `左端点应精确命中 100，实得 ${sampleChannel(clampKeys, 10)}`);
  check(near(sampleChannel(clampKeys, 40), 200), `右端点应精确命中 200，实得 ${sampleChannel(clampKeys, 40)}`);
  check(
    near(sampleChannel(clampKeys, -100), 100),
    `左侧区间外应钳到首帧 100，实得 ${sampleChannel(clampKeys, -100)}`,
  );
  check(
    near(sampleChannel(clampKeys, 9999), 200),
    `右侧区间外应钳到末帧 200，实得 ${sampleChannel(clampKeys, 9999)}`,
  );
  // 单关键帧 / 空通道不能炸
  check(near(sampleChannel([kf(7, 3)], 100), 3), "单关键帧应恒为该值");
  check(sampleChannel([], 5) === 0, "空通道应返回 0");

  // enabled:false ⇒ 控制点落在弦上 ⇒ 严格线性
  const lin = sampleChannel(keys, 15);
  check(near(lin, 25, 1e-4), `enabled:false 应退化为线性（期望 25），实得 ${lin}`);

  // x=1,y=0 是**水平切线**（标准缓动），不是线性 —— 全库 456/535 段是这个形态。
  // 中点必须仍是 25（对称 ease 的对称性），但 1/4 处要明显慢于线性。
  const ease = [
    kf(0, 10, { enabled: true, x: 1, y: 0 }, null),
    kf(30, 40, null, { enabled: true, x: 1, y: 0 }),
  ];
  const eMid = sampleChannel(ease, 15);
  const eQ = sampleChannel(ease, 7.5);
  const linQ = 10 + (40 - 10) * 0.25;
  check(near(eMid, 25, 1e-3), `对称缓动中点应为 25，实得 ${eMid}`);
  check(
    eQ < linQ - 0.5,
    `x=1,y=0 应是水平切线（起步慢于线性）：1/4 处 ${eQ.toFixed(3)} 应显著小于 ${linQ}`,
  );

  // 手柄的 y 是**绝对增量**（不是斜率、不是归一化比例）。
  // front.y=+15 把左控制点抬到 v0+15=25 ⇒ 曲线在前半段应明显高于线性。
  const lift = [
    kf(0, 10, { enabled: true, x: 1, y: 15 }, null),
    kf(30, 40, null, { enabled: true, x: -1, y: 0 }),
  ];
  const liftQ = sampleChannel(lift, 7.5);
  const linQ2 = 10 + (40 - 10) * 0.25;
  check(
    liftQ > linQ2 + 1,
    `front.y=+15 应抬高前段（1/4 处 ${liftQ.toFixed(3)} 应高于线性 ${linQ2}）`,
  );
  // 反向：front.y 为负应压低前段
  const drop = [
    kf(0, 10, { enabled: true, x: 1, y: -8 }, null),
    kf(30, 40, null, { enabled: true, x: -1, y: 0 }),
  ];
  const dropQ = sampleChannel(drop, 7.5);
  check(dropQ < linQ2 - 1, `front.y=-8 应压低前段，实得 ${dropQ.toFixed(3)}`);

  // 手柄的 y 是绝对量纲：把两端的值整体放大 100 倍、y 也放大 100 倍，
  // 曲线应等比放大（若把 y 当成归一化比例，这条不成立）。
  const small = [
    kf(0, 0, { enabled: true, x: 1, y: 3 }, null),
    kf(30, 10, null, { enabled: true, x: -1, y: -2 }),
  ];
  const big = [
    kf(0, 0, { enabled: true, x: 1, y: 300 }, null),
    kf(30, 1000, null, { enabled: true, x: -1, y: -200 }),
  ];
  const sm = sampleChannel(small, 12);
  const bg = sampleChannel(big, 12);
  check(
    near(bg, sm * 100, Math.abs(sm) * 1e-6 + 1e-6),
    `y 应为绝对增量（等比放大 100 倍后期望 ${(sm * 100).toFixed(4)}，实得 ${bg.toFixed(4)}）`,
  );

  // 曲线不得越过端点包络太多：标准手柄下极值应落在 [min,max] 附近
  const env = [
    kf(0, 0, { enabled: true, x: 1, y: 0 }, null),
    kf(60, 1, null, { enabled: true, x: -1, y: 0 }),
  ];
  let eMin = Infinity;
  let eMax = -Infinity;
  for (let f = 0; f <= 60; f += 0.5) {
    const v = sampleChannel(env, f);
    if (v < eMin) eMin = v;
    if (v > eMax) eMax = v;
  }
  check(
    eMin >= -1e-6 && eMax <= 1 + 1e-6,
    `标准缓动不应超出端点包络，实得 [${eMin.toFixed(4)}, ${eMax.toFixed(4)}]`,
  );

  // `x` 是「段长的比例」，不是固定的 1/3：|x| 变短会把控制点拉近端点，
  // 曲线形状必须随之改变。全库 x ∈ [0.51, 1.12]，若实现里写死 1/3，
  // 这些非 1 的手柄就全部失效（表现为缓动节奏不对，但不会报错）。
  const xWide = [
    kf(0, 0, { enabled: true, x: 1, y: 20 }, null),
    kf(30, 100, null, { enabled: true, x: -1, y: 0 }),
  ];
  const xNarrow = [
    kf(0, 0, { enabled: true, x: 0.52, y: 20 }, null),
    kf(30, 100, null, { enabled: true, x: -1, y: 0 }),
  ];
  const wMid = sampleChannel(xWide, 10);
  const nMid = sampleChannel(xNarrow, 10);
  check(
    Math.abs(wMid - nMid) > 0.5,
    `front.x 的比例应影响曲线（x=1 得 ${wMid.toFixed(3)}，x=0.52 得 ${nMid.toFixed(3)}，几乎相同说明 x 被忽略）`,
  );
  // back.x 同理
  const bWide = [
    kf(0, 0, { enabled: true, x: 1, y: 0 }, null),
    kf(30, 100, null, { enabled: true, x: -1, y: -20 }),
  ];
  const bNarrow = [
    kf(0, 0, { enabled: true, x: 1, y: 0 }, null),
    kf(30, 100, null, { enabled: true, x: -0.52, y: -20 }),
  ];
  const bwMid = sampleChannel(bWide, 20);
  const bnMid = sampleChannel(bNarrow, 20);
  check(
    Math.abs(bwMid - bnMid) > 0.5,
    `back.x 的比例应影响曲线（${bwMid.toFixed(3)} vs ${bnMid.toFixed(3)}）`,
  );

  // back.y 的符号：控制点是 v1 + back.y。负的 back.y 把右控制点**压到端点下方**，
  // 曲线在后段应低于「back.y 为正」的同形曲线。符号弄反会让缓入变缓出，
  // 数值上仍然连续、仍在包络内 —— 只有拿两个符号对比才能抓住。
  const bNeg = [
    kf(0, 0, { enabled: true, x: 1, y: 0 }, null),
    kf(30, 100, null, { enabled: true, x: -1, y: -30 }),
  ];
  const bPos = [
    kf(0, 0, { enabled: true, x: 1, y: 0 }, null),
    kf(30, 100, null, { enabled: true, x: -1, y: 30 }),
  ];
  const negLate = sampleChannel(bNeg, 22);
  const posLate = sampleChannel(bPos, 22);
  check(
    negLate < posLate - 1,
    `back.y 为负应压低后段（negLate ${negLate.toFixed(3)} 应小于 posLate ${posLate.toFixed(3)}）`,
  );

  // 单调段不应出现回退（贝塞尔手柄合法时 x(t) 单调）
  let prev = -Infinity;
  let mono = true;
  for (let f = 0; f <= 30; f += 0.5) {
    const v = sampleChannel(ease, f);
    if (v < prev - 1e-6) mono = false;
    prev = v;
  }
  check(mono, "对称缓动应单调递增");
}

// ---------- 2. wrapFrame 三种 mode ----------
{
  check(wrapFrame(-5, 60, "single") === 0, "single 负帧应钳到 0");
  check(wrapFrame(80, 60, "single") === 60, "single 超长应钳到 length");
  check(near(wrapFrame(70, 60, "loop"), 10), `loop 70/60 应为 10，实得 ${wrapFrame(70, 60, "loop")}`);
  check(near(wrapFrame(-10, 60, "loop"), 50), `loop 负向应回绕到 50，实得 ${wrapFrame(-10, 60, "loop")}`);
  // mirror：一个来回是 2*length，70 落在回程 ⇒ 2*60-70 = 50
  check(near(wrapFrame(70, 60, "mirror"), 50), `mirror 70 应折返为 50，实得 ${wrapFrame(70, 60, "mirror")}`);
  check(near(wrapFrame(30, 60, "mirror"), 30), "mirror 去程应原样");
  check(wrapFrame(10, 0, "loop") === 0, "length=0 不应产生 NaN/除零");

  // wraploop：loop 时从末关键帧平滑接到首关键帧（官方 Wrap loop frames）。
  // 不做的话 length 大于末帧的那段会钳在末值，环绕瞬间跳回首帧。
  {
    const keys = [kf(0, 0), kf(60, 100)];
    const hold = sampleChannel(keys, 70);
    check(near(hold, 100), `无 wrap 时 70 应钳在末值 100，实得 ${hold}`);
    const mid = sampleChannel(keys, 70, { length: 80 });
    check(near(mid, 50, 1e-3), `wraploop 70/80 应是 100→0 的中点 50，实得 ${mid}`);
    // 控制器必须把 options.wraploop 传进 sampleChannel，只测核函数会漏接线
    const wrapped = createAnimation({
      c0: keys,
      options: { fps: 30, length: 80, mode: "loop", wraploop: true },
    });
    wrapped.setFrame(70);
    check(near(wrapped.value(), 50, 1e-3), `控制器 wraploop 70 应为 50，实得 ${wrapped.value()}`);
    const plain = createAnimation({
      c0: keys,
      options: { fps: 30, length: 80, mode: "loop" },
    });
    plain.setFrame(70);
    check(near(plain.value(), 100), `未开 wraploop 的 loop 70 应仍钳在 100，实得 ${plain.value()}`);
    // 首帧不在 0：wrap 只占末帧→length，开头仍钳在首值（火1 origin 首帧 191）
    const gap = [kf(20, 0), kf(60, 80)];
    const head = sampleChannel(gap, 10, { length: 100 });
    check(near(head, 0), `wraploop 不应改写首帧之前的钳制，f=10 应得 0，实得 ${head}`);
    const tail = sampleChannel(gap, 80, { length: 100 });
    check(near(tail, 40, 1e-3), `wraploop 尾段 80 应是 80→0 的中点 40，实得 ${tail}`);

    // 真实语料：3233141951「火1」origin 首帧 191、末帧 847=+64px、length=900
    const firePkg = join(LIB, "3233141951", "scene.pkg");
    if (fs.existsSync(firePkg)) {
      const fireScene = JSON.parse(
        Buffer.from(getEntry(parsePkg(fs.readFileSync(firePkg)), "scene.json")).toString("utf8"),
      );
      const fire = (fireScene.objects || []).find((o) => o.name === "火1");
      const origin = fire && fire.origin && fire.origin.animation;
      check(!!origin, "3233141951 火1 应有 origin 动画");
      if (origin) {
        check(origin.options && origin.options.wraploop === true, "火1 origin 应开 wraploop");
        const ctrl = createAnimation(origin);
        ctrl.setFrame(0);
        const x0 = Array.isArray(ctrl.value()) ? ctrl.value()[0] : ctrl.value();
        check(near(x0, 0, 0.5), `火1 origin 开头应钳在首值 0，实得 ${x0}`);
        ctrl.setFrame(847);
        const x847 = Array.isArray(ctrl.value()) ? ctrl.value()[0] : ctrl.value();
        check(x847 > 50, `火1 origin 末关键帧应得 +64px 左右，实得 ${x847}`);
        ctrl.setFrame(870);
        const x870 = Array.isArray(ctrl.value()) ? ctrl.value()[0] : ctrl.value();
        check(
          x870 < x847 - 1 && x870 > 1,
          `火1 origin wraploop 尾段应在 64→0 过渡中，实得 ${x870}`,
        );
      }
    }
  }

  // 效果常量关键帧必须接到 renderer：3233141951 剑音条 opacity 快照是 0，
  // 真正淡入在第 18 帧。只跑 {script} 的话武士刀音频条永远透明。
  {
    const rsrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/render/renderer.js"), "utf8");
    check(/function animatedConstants/.test(rsrc),
      "renderer.js 缺少 animatedConstants：效果常量 {animation} 不会被采样");
    check(/animatedConstants\s*\(\s*scriptedConstants/.test(rsrc.replace(/\s+/g, " ")),
      "bindConstants 必须先 scriptedConstants 再 animatedConstants（常量动画接不到 pass）");
    const pkgPath = join(LIB, "3233141951", "scene.pkg");
    if (fs.existsSync(pkgPath)) {
      const scene = JSON.parse(
        Buffer.from(getEntry(parsePkg(fs.readFileSync(pkgPath)), "scene.json")).toString("utf8"),
      );
      const bar = (scene.objects || []).find((o) => o.name === "剑音条01");
      const op = bar && bar.effects && bar.effects[0] && bar.effects[0].passes
        && bar.effects[0].passes[0] && bar.effects[0].passes[0].constantshadervalues
        && bar.effects[0].passes[0].constantshadervalues.ui_editor_properties_opacity;
      check(!!(op && op.animation), "3233141951 剑音条01 应有 opacity 关键帧");
      if (op && op.animation) {
        const ctrl = createAnimation(op.animation);
        ctrl.setFrame(0);
        check(near(ctrl.value(), 0, 0.02), `剑音条01 t=0 opacity 应钳在 0，实得 ${ctrl.value()}`);
        ctrl.setFrame(56);
        check(ctrl.value() > 0.7, `剑音条01 第 56 帧应淡入到 ~0.78，实得 ${ctrl.value()}`);
        ctrl.setFrame(594);
        check(near(ctrl.value(), 0, 0.02), `剑音条01 刀飞走后 opacity 应回 0，实得 ${ctrl.value()}`);
      }
    }
  }
}

// ---------- 3. 控制器语义 ----------
{
  // startpaused:true ⇒ 初始不推进
  const paused = createAnimation({
    c0: [kf(0, 0), kf(60, 60)],
    options: { fps: 60, length: 60, mode: "single", startpaused: true },
  });
  paused.advance(0.5);
  check(paused.getFrame() === 0, `startpaused 不应自动推进，实得 ${paused.getFrame()}`);
  paused.play();
  paused.advance(0.5);
  check(near(paused.getFrame(), 30), `play 后 0.5s@60fps 应到 30 帧，实得 ${paused.getFrame()}`);

  // 缺省自动播放
  const auto = createAnimation({
    c0: [kf(0, 0), kf(60, 60)],
    options: { fps: 60, length: 60 },
  });
  auto.advance(0.25);
  check(near(auto.getFrame(), 15), `缺省应自动播放，实得 ${auto.getFrame()}`);

  // single 到头停住 + ended 回调**只触发一次**
  let endedCount = 0;
  const once = createAnimation({
    c0: [kf(0, 0), kf(30, 10)],
    options: { fps: 30, length: 30, mode: "single" },
  });
  once.addEndedCallback(() => endedCount++);
  for (let i = 0; i < 10; i++) once.advance(0.5);
  check(once.getFrame() === 30, `single 应停在 length，实得 ${once.getFrame()}`);
  check(!once.playing, "single 到头应停止播放");
  check(endedCount === 1, `ended 回调应只触发一次，实得 ${endedCount}`);
  // 重播后应能**再触发一次**（play() 要清 ended 标志）：语料里
  // `mediaThumbnailChanged` 常写 `anim.stop(); anim.play();`，若 ended 不复位，
  // 换歌后的「播完回调」就再也不来了。
  once.stop();
  once.play();
  for (let i = 0; i < 10; i++) once.advance(0.5);
  check(endedCount === 2, `重播后 ended 应再触发一次（累计 2），实得 ${endedCount}`);

  // 回调抛错不能拖垮推进
  const boom = createAnimation({ c0: [kf(0, 0), kf(10, 1)], options: { fps: 10, length: 10 } });
  boom.addEndedCallback(() => {
    throw new Error("boom");
  });
  let threw = false;
  try {
    boom.advance(5);
  } catch {
    threw = true;
  }
  check(!threw, "ended 回调抛错不应冒泡到渲染循环");

  // 负 rate 倒放
  const rev = createAnimation({ c0: [kf(0, 0), kf(60, 60)], options: { fps: 60, length: 60 } });
  rev.setFrame(60).setRate(-1);
  rev.advance(0.5);
  check(near(rev.getFrame(), 30), `负 rate 应倒放到 30，实得 ${rev.getFrame()}`);

  // 小数 fps（1.2 / 0.725 / 2.9 在库里真实存在）
  const slow = createAnimation({ c0: [kf(0, 0), kf(10, 1)], options: { fps: 1.2, length: 10 } });
  slow.advance(10);
  check(near(slow.getFrame(), 12, 1e-9) || slow.getFrame() === 10, `小数 fps 推进异常：${slow.getFrame()}`);

  // stop 回零、pause 保位
  const sp = createAnimation({ c0: [kf(0, 0), kf(60, 60)], options: { fps: 60, length: 60 } });
  sp.advance(0.5);
  sp.pause();
  const held = sp.getFrame();
  sp.advance(0.5);
  check(sp.getFrame() === held, "pause 后不应继续推进");
  sp.stop();
  check(sp.getFrame() === 0, "stop 应回到 0 帧");

  // relative：叠加基准而非替换（34 处，仅 origin/angles/scale）
  const rel = createAnimation({
    c0: [kf(0, 0), kf(30, 100)],
    c1: [kf(0, 0), kf(30, 200)],
    options: { fps: 30, length: 30 },
    relative: true,
  });
  rel.setFrame(30);
  const frozen = [5, 7];
  const out = rel.applyTo(frozen);
  check(
    Array.isArray(out) && near(out[0], 105) && near(out[1], 207),
    `relative 应叠加基准，期望 [105,207]，实得 ${JSON.stringify(out)}`,
  );
  const out2 = rel.applyTo(frozen);
  check(
    Array.isArray(out2) && near(out2[0], 105) && near(out2[1], 207),
    `relative 反复 applyTo 同一快照应得同一结果，实得 ${JSON.stringify(out2)}`,
  );
  check(frozen[0] === 5 && frozen[1] === 7, "applyTo 不应改写调用方传入的基准数组");
  // scene.json 的 value 是 `"x y z"` 字符串，也要能当基准
  const fromStr = rel.applyTo("5 7 0");
  check(
    Array.isArray(fromStr) && near(fromStr[0], 105) && near(fromStr[1], 207),
    `relative 应能解析字符串基准，实得 ${JSON.stringify(fromStr)}`,
  );
  // 接线：渲染循环必须喂冻结快照。把输出再当 base 会把曲线积分掉
  // （3233141951 头发 angles 0.14rad × 80 帧 ≈ 一整圈）。
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(
    /baseNumeric/.test(mountSrc) && /applyTo\(run\.ctrl\.baseNumeric\)/.test(mountSrc),
    "relative 动画必须叠加冻结基准，不能每帧把 layer.origin 当 base",
  );
  // 非 relative 直接取动画值
  const abs = createAnimation({
    c0: [kf(0, 0), kf(30, 100)],
    options: { fps: 30, length: 30 },
  });
  abs.setFrame(30);
  check(near(abs.applyTo(999), 100), "非 relative 不应叠加基准");

  // 多通道各自独立时间轴（4 处各通道帧数不同）
  const multi = createAnimation({
    c0: [kf(0, 0), kf(30, 30)],
    c1: [kf(0, 0), kf(10, 10), kf(30, 0)],
    options: { fps: 30, length: 30 },
  });
  multi.setFrame(10);
  const mv = multi.value();
  check(Array.isArray(mv) && mv.length === 2, "双通道应返回长度 2 的数组");
  check(near(mv[0], 10) && near(mv[1], 10), `各通道应独立求值，实得 ${JSON.stringify(mv)}`);

  // mode 必须**经过控制器**生效：只测 wrapFrame 会漏掉「createAnimation 把
  // mirror 误当 loop」这类错误（sampleChannel/wrapFrame 单测全绿也照样漏）。
  // 同一条通道、同一个超长帧号，三种 mode 的取值必须两两不同。
  const modeKeys = [kf(0, 0), kf(60, 60)];
  const at = (mode, f) => {
    const a = createAnimation({ c0: modeKeys, options: { fps: 60, length: 60, mode } });
    a.setFrame(f);
    return a.value();
  };
  const vSingle = at("single", 70);
  const vLoop = at("loop", 70);
  const vMirror = at("mirror", 70);
  check(near(vSingle, 60), `控制器 single 应钳到末值 60，实得 ${vSingle}`);
  check(near(vLoop, 10, 1e-3), `控制器 loop 应回绕到 10，实得 ${vLoop}`);
  check(near(vMirror, 50, 1e-3), `控制器 mirror 应折返到 50，实得 ${vMirror}`);
  check(
    !near(vLoop, vMirror, 1e-3),
    `loop 与 mirror 在同一帧不应相等（mirror 可能被当成了 loop）：${vLoop} vs ${vMirror}`,
  );

  // 中性控制器：链式调用不炸、值为 null
  const n = createNeutralAnimation();
  let neutralOk = true;
  try {
    n.play().stop().setFrame(5).setRate(2).addEndedCallback(() => {});
    n.advance(1);
  } catch {
    neutralOk = false;
  }
  check(neutralOk, "中性控制器的链式调用不应抛错");
}

// ---------- 4. 真实壁纸数据全量回归 ----------
{
  let libAnims = 0;
  let libWallpapers = 0;
  let libKeys = 0;
  let nonLinear = 0;
  let relativeCount = 0;
  const modeCount = { single: 0, loop: 0, mirror: 0 };
  const fieldCount = new Map();
  let badValue = 0;
  let outOfRange = 0;
  let worstOver = 0;
  let worstWhere = "";

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
    if (!scene || !Array.isArray(scene.objects)) continue;
    let hit = false;

    // 通用遍历：`animation` 不只挂在对象字段上 —— 全库 125 处里有 55 处挂在
    // **效果常量**（multiply / amount / point0..3 / zoom / volume / maxwidth）。
    // 按固定字段白名单扫只能看到一半，会让另一半悄悄失去回归覆盖。
    const walk = (node, parentKey) => {
      if (Array.isArray(node)) {
        for (const x of node) walk(x, parentKey);
        return;
      }
      if (!node || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        if (k === "animation" && v && typeof v === "object" && !Array.isArray(v)) {
          hit = true;
          libAnims++;
          const field = parentKey || "?";
          fieldCount.set(field, (fieldCount.get(field) || 0) + 1);
          const ctrl = createAnimation(v);
          const opts = v.options || {};
          const mode = opts.mode === "loop" || opts.mode === "mirror" ? opts.mode : "single";
          modeCount[mode]++;
          if (v.relative) relativeCount++;

          const chans = [];
          for (let i = 0; ; i++) {
            const c = v["c" + i];
            if (!Array.isArray(c)) break;
            chans.push(c);
            libKeys += c.length;
            for (const kk of c) {
              if ((kk.front && kk.front.enabled) || (kk.back && kk.back.enabled)) nonLinear++;
            }
          }
          if (chans.length === 0) continue;

          // 每个通道的「自身量级」：端点值与手柄增量的最大绝对值。
          // 不能用 (hi-lo) 作分母 —— 全库 107 处是**平段**（v0==v1，跨度为 0），
          // 那样任何非零手柄都会被判成无穷倍越界，是度量本身的伪影而非错误。
          const scale = [];
          const lo = [];
          const hi = [];
          for (const c of chans) {
            let a = Infinity;
            let b = -Infinity;
            let mag = 1e-6;
            for (const kk of c) {
              const n = Number(kk.value);
              if (Number.isFinite(n)) {
                if (n < a) a = n;
                if (n > b) b = n;
                mag = Math.max(mag, Math.abs(n));
              }
              for (const h of [kk.front, kk.back]) {
                if (h && h.enabled) mag = Math.max(mag, Math.abs(Number(h.y) || 0));
              }
            }
            lo.push(a);
            hi.push(b);
            scale.push(mag);
          }

          const len = Number(opts.length) > 0 ? Number(opts.length) : 60;
          for (let f = -5; f <= len + 5; f += Math.max(0.5, len / 120)) {
            ctrl.setFrame(f);
            const val = ctrl.value();
            const arr = Array.isArray(val) ? val : [val];
            for (let i = 0; i < arr.length; i++) {
              if (!Number.isFinite(arr[i])) {
                badValue++;
                continue;
              }
              const over = Math.max(arr[i] - hi[i], lo[i] - arr[i]) / scale[i];
              if (over > 2) {
                outOfRange++;
                if (over > worstOver) {
                  worstOver = over;
                  worstWhere = `${id}/${field} 通道${i} 值 ${arr[i].toFixed(3)} 越出 [${lo[i]},${hi[i]}]`;
                }
              }
            }
          }
          continue;
        }
        walk(v, k);
      }
    };
    walk(scene.objects, null);
    if (hit) libWallpapers++;
  }

  if (libAnims > 0) {
    check(badValue === 0, `真实动画求值出现 ${badValue} 个非有限值（NaN/Infinity）`);
    check(
      outOfRange === 0,
      `真实动画有 ${outOfRange} 个采样超出自身量级 2 倍以上（手柄语义可能解释错了）；最坏：${worstWhere}`,
    );
    // 「数据面貌」断言：库或解析变了要人来看一眼，而不是悄悄放行
    check(nonLinear > 0, "库里应存在带切线手柄的关键帧（若为 0，说明 front/back 解析丢了）");
    check(relativeCount > 0, "库里应存在 relative:true 的动画（若为 0，说明 relative 字段丢了）");
    check(
      modeCount.loop > 0 && modeCount.mirror > 0,
      `库里应同时存在 loop 与 mirror（实得 ${JSON.stringify(modeCount)}）`,
    );
    // 效果常量上的动画必须被扫到：它们占全库近一半，早先按对象字段白名单
    // 遍历时整块漏掉（70 vs 125）。这条守住覆盖率不再退回去。
    const effectFields = ["multiply", "amount", "zoom", "point0", "point1", "point2", "point3"];
    const effectHits = effectFields.reduce((s, f) => s + (fieldCount.get(f) || 0), 0);
    check(
      effectHits > 0,
      `效果常量上的动画应被覆盖（multiply/amount/point*/zoom），实得 0；字段分布 ${JSON.stringify([...fieldCount])}`,
    );
    console.log(
      `  真实库：${libAnims} 处动画 / ${libWallpapers} 张壁纸 / ${libKeys} 关键帧` +
        `（非线性 ${nonLinear}，relative ${relativeCount}，${JSON.stringify(modeCount)}，` +
        `其中效果常量 ${effectHits} 处）`,
    );
  } else {
    console.log("  真实库：未找到壁纸库，跳过全量回归");
  }
}

// ---------- 5. general.*.animation（2887099508 zoom 开场拉远）----------
// 图层 objectAnimations 进不了 general。zoom 快照是 3，不播这条轨
// 就永远只看见 6080×3420 的中间 1/3。
{
  const parseMod = await imp("renderer/vendor/we-scene/scene/parse.js");
  const psrc = fs.readFileSync(join(ROOT, "renderer/vendor/we-scene/scene/parse.js"), "utf8");
  check(/generalAnimations/.test(psrc), "parse.js 必须抽出 general.*.animation（否则 zoom 开场轨丢失）");
  const mount = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(/generalAnimations/.test(mount), "scene-mount 未加载 generalAnimations");
  check(/generalAnimRuns/.test(mount), "scene-mount 必须逐帧推进 generalAnimRuns");
  check(/writeGeneralField/.test(mount), "scene-mount 必须把 general 动画写回 cameraTransforms.zoom");

  const pkgPath = join(LIB, "2887099508", "scene.pkg");
  if (!fs.existsSync(pkgPath)) {
    console.log("  （跳过 2887099508 语料：本机无此壁纸）");
  } else {
    const scene = JSON.parse(
      Buffer.from(getEntry(parsePkg(fs.readFileSync(pkgPath)), "scene.json")).toString("utf8"),
    );
    const parsed = parseMod.parseScene(scene, null);
    check(!!(parsed.generalAnimations && parsed.generalAnimations.zoom),
      "2887099508 parseScene 应留下 generalAnimations.zoom");
    const def = parsed.generalAnimations && parsed.generalAnimations.zoom;
    if (def && def.animation) {
      const ctrl = createAnimation(def.animation);
      check(ctrl.playing, "2887099508 zoom 缺省应自动播放（没有 startpaused）");
      ctrl.setFrame(0);
      check(near(ctrl.value(), 3, 0.02), `zoom 第 0 帧应为 3，实得 ${ctrl.value()}`);
      ctrl.setFrame(300);
      check(near(ctrl.value(), 3, 0.02), `zoom 前 10 秒应停在 3，实得 ${ctrl.value()}`);
      ctrl.setFrame(450);
      check(near(ctrl.value(), 1, 0.02), `zoom 第 450 帧应拉到 1，实得 ${ctrl.value()}`);
      const auto = createAnimation(def.animation);
      auto.advance(10);
      check(near(auto.value(), 3, 0.05), `zoom 播 10 秒应仍是 3 倍特写，实得 ${auto.value()}`);
      auto.advance(5);
      check(near(auto.value(), 1, 0.05), `zoom 播 15 秒应拉到 1（整张 6080×3420），实得 ${auto.value()}`);
    }
  }
}

// ---------- 关键帧动画必须与骨骼动画同一时钟（3233141951 头发/头不同步、漏模）----------
//
// 骨骼动画（puppet）走渲染循环里的真实时钟 `t = (now - start - pauseAccum)/1000`；
// 关键帧动画（objectAnimations）曾按 `advance(interval / 1000)` 累加**目标**帧间隔。
// 渲染门是 `now - lastRender >= interval`，实际出帧周期总略大于 interval，
// 每帧只加 interval 就是系统性欠计 —— 两条时间轴持续发散。
//
// 3233141951 的头是唯一 puppet 层（骨骼动画 63，30fps/900 帧），头发0202 / 头发负形 /
// 发饰 / 补 都是 quad 靠 origin 关键帧位移（同样 30fps/900 帧，本该严格同步）。
// 漂移的表现就是用户报的「头发和头部运动轨迹不统一，出现漏模」。
{
  console.log("\n[时钟同步] 关键帧动画 vs 骨骼动画");

  // 1) 接线断言：渲染循环不得再用目标帧间隔喂 advance / frametime
  const mountSrc = fs.readFileSync(join(ROOT, "renderer/src/scene-mount.ts"), "utf8");
  check(
    !/\.advance\(interval \/ 1000\)/.test(mountSrc),
    "关键帧动画不得按目标帧间隔累加（与骨骼的真实时钟发散，3233141951 漏模）",
  );
  check(
    !/frametime = interval \/ 1000/.test(mountSrc),
    "engine.frametime 不得用目标帧间隔（须与同一行的 runtime 同时基）",
  );
  check(
    /const animDt = Math\.max\(0, t - lastAnimT\)/.test(mountSrc) &&
      /\.advance\(animDt\)/.test(mountSrc),
    "关键帧动画必须用真实经过时间 animDt 推进",
  );
  // animDt 是**帧间增量**，算完必须立刻推进 lastAnimT。漏掉这一句 dt 会变成
  // 「从头到现在的累计时间」，播放头按 t 的平方增长 —— 动画瞬间飞出值域，
  // 而上面几条正则断言全都照过（正则只看形状，不看语义）。
  check(
    /const animDt = Math\.max\(0, t - lastAnimT\);\s*\n\s*lastAnimT = t;/.test(mountSrc),
    "算出 animDt 后必须立即推进 lastAnimT（否则 dt 变成累计时间，播放头按 t² 增长）",
  );
  check(
    (mountSrc.match(/frametime = animDt/g) || []).length === 3,
    "三处 engine.frametime（效果开关 / general / 对象脚本）都应改用 animDt",
  );

  // 2) 数值判据：模拟渲染循环，两种推进方式各跑一遍，比对与真实时钟的偏差。
  //    真实帧间隔取几档（含理想满帧）——重点是**即便满帧也会漂**，因为门限是 >=。
  const pkgPath = join(LIB, "3233141951", "scene.pkg");
  if (fs.existsSync(pkgPath)) {
    const pkg = parsePkg(new Uint8Array(fs.readFileSync(pkgPath)));
    const raw = JSON.parse(new TextDecoder().decode(getEntry(pkg, "scene.json")));
    const hair = (raw.objects || []).find((o) => o.name === "头发0202");
    check(!!hair?.origin?.animation, "3233141951 头发0202 应有 origin 关键帧动画");
    const head = (raw.objects || []).find((o) => o.name === "头");
    check(
      Array.isArray(head?.animationlayers) && head.animationlayers.length > 0,
      "3233141951 头应有骨骼 animationlayers（对照时钟的另一侧）",
    );

    if (hair?.origin?.animation) {
      /** 模拟渲染循环。mode=fixed 复现旧行为，real 是修复后的行为，
       *  noAdvance 复现「算了 animDt 却忘记推进 lastAnimT」这个改错方式。 */
      const simulate = (realFrameMs, seconds, mode, targetFps = 60) => {
        const ctrl = createAnimation(hair.origin.animation);
        const interval = 1000 / targetFps;
        let now = 0;
        let lastRender = -Infinity;
        let lastAnimT = 0;
        while (now < seconds * 1000) {
          now += realFrameMs;
          if (now - lastRender >= interval) {
            lastRender = now;
            const t = now / 1000;
            if (mode === "fixed") ctrl.advance(interval / 1000);
            else if (mode === "noAdvance") ctrl.advance(Math.max(0, t - lastAnimT));
            else {
              ctrl.advance(Math.max(0, t - lastAnimT));
              lastAnimT = t;
            }
          }
        }
        return ctrl.getFrame();
      };

      for (const [label, ms] of [
        ["理想满帧 60fps", 1000 / 60],
        ["120Hz 显示器", 1000 / 120],
        ["掉帧到 40fps", 25],
      ]) {
        const secs = 30;
        const truth = secs * 30; // 骨骼按真实时钟走到的帧（动画 fps=30）
        const fixed = simulate(ms, secs, "fixed");
        const real = simulate(ms, secs, "real");
        // 修复后必须紧跟真实时钟（容差 1 帧 ≈ 33ms）
        check(
          Math.abs(real - truth) <= 1,
          `${label}：真实 dt 推进应跟住骨骼时钟（期望 ${truth} 帧，实得 ${real.toFixed(1)}）`,
        );
        // 且必须明显优于旧行为，否则这条断言等于没测
        check(
          Math.abs(fixed - truth) > Math.abs(real - truth) + 10,
          `${label}：旧的固定累加应显著偏离（旧 ${fixed.toFixed(1)} / 新 ${real.toFixed(1)} / 真值 ${truth}）`,
        );
        console.log(
          `   ${label}: 旧 ${fixed.toFixed(1)} 帧 / 新 ${real.toFixed(1)} 帧 / 真值 ${truth} 帧`,
        );
      }

      // 「忘记推进 lastAnimT」是最容易写错的一步，且正则断言看不出来：
      // dt 变成累计时间后播放头按 t² 增长，30s 会冲到真值的几十倍。
      {
        const truth = 30 * 30;
        const broken = simulate(1000 / 60, 30, "noAdvance");
        check(
          broken > truth * 5,
          `漏推进 lastAnimT 应让播放头爆炸式增长（真值 ${truth}，实得 ${broken.toFixed(1)}）—— ` +
            `若这条不成立，说明模拟没能复现该错误，判据失去意义`,
        );
        console.log(`   （对照）漏推进 lastAnimT: ${broken.toFixed(0)} 帧 vs 真值 ${truth} 帧`);
      }

      // 3) 漂移换算成画面偏移：头发相对头顶错开几十像素就是肉眼可见的漏模
      const ctrl = createAnimation(hair.origin.animation);
      const base = hair.origin.value;
      const at = (f) => {
        ctrl.setFrame(f);
        return ctrl.applyTo(base);
      };
      let worst = 0;
      for (let f = 0; f < 900; f++) {
        const a = at(f);
        const b = at(f + 164); // 理想满帧下 30s 的实测漂移量
        worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
      check(
        worst > 20,
        `漂移 164 帧应造成显著位移（>20px），实得 ${worst.toFixed(1)}px —— 若变小说明语料换了，判据需重新标定`,
      );
      console.log(`   漂移 164 帧 → 头发0202 最大偏移 ${worst.toFixed(1)}px（漏模量级）`);
    }
  }
}

if (errors.length) {
  console.error(`verify-animation: ${errors.length} 处失败`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log("verify-animation: all checks passed");
