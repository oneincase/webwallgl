// 光标水波（cursor ripple）：鼠标划过画面拖出向外扩散的水波，按住左键持续起波。
//
// 三个 pass、两张跨帧保留的 512 长边 8 位缓冲乒乓：
//   inject  读上一帧的力场 B，沿光标本帧扫过的线段注入冲量 → 写 A
//   sim     读 A，四个方向通道各自向前传播、侧向扩散、碰边折返、衰减 → 写 B（下一帧的输入）
//   combine 读 B 求偏移方向，扭曲本效果的输入画面（previous），可选明暗着色
// 力场按方向拆成 +x / +y / -x / -y 四个非负通道，所以 8 位 RGBA 就够用（WE 端也能跑）。
// 挂在铺满画面的容器层 / 全屏后期层上就是整幅壁纸的水波；挂在单张图层上只作用于该层。

import { defineEffect, type EffectDef, type EffectParam } from "../../effects";
import INJECT_DECL from "../../shaders/effects/cursorripple-inject.decl.glsl";
import INJECT_BODY from "../../shaders/effects/cursorripple-inject.body.glsl";
import SIM_DECL from "../../shaders/effects/cursorripple-sim.decl.glsl";
import SIM_BODY from "../../shaders/effects/cursorripple-sim.body.glsl";
import COMBINE_DECL from "../../shaders/effects/cursorripple-combine.decl.glsl";
import COMBINE_BODY from "../../shaders/effects/cursorripple-combine.body.glsl";

const FIELD_A = "_rt_wwglRippleA";
const FIELD_B = "_rt_wwglRippleB";

// 缺省值取自工坊壁纸 3454792257 的调校（笔刷 0.35 / 传播 1 / 衰减 1.05 / 折射 0.35）
const PARAMS: EffectParam[] = [
  { key: "ripplescale", type: "float", default: 0.35, min: 0.05, max: 2, step: 0.01, pass: 0 },
  { key: "rippleclick", type: "float", default: 1, min: 0, max: 3, step: 0.05, pass: 0 },
  { key: "ripplespeed", type: "float", default: 1, min: 0, max: 2, step: 0.01, pass: 1 },
  { key: "rippledecay", type: "float", default: 1.05, min: 0, max: 4, step: 0.01, pass: 1 },
  { key: "ripplereflect", type: "bool", default: true, pass: 1 },
  { key: "ripplestrength", type: "float", default: 0.35, min: 0, max: 5, step: 0.01, pass: 2 },
  { key: "rippleshading", type: "float", default: 0, min: 0, max: 2, step: 0.01, pass: 2 },
  { key: "rippleshadingdir", type: "float", default: 0, min: 0, max: 6.2832, step: 0.01, pass: 2 },
  { key: "ripplehighlight", type: "color", default: [1, 1, 1], pass: 2 },
  { key: "rippleshadow", type: "color", default: [0, 0, 0], pass: 2 },
];

export const CURSOR_RIPPLE: EffectDef = defineEffect({
  id: "cursorripple",
  category: "interactive",
  note: {
    zh: "参考 Wallpaper Engine 官方「光标涟漪」的方向力场做法，本仓独立实现；缺省参数取自工坊壁纸 3454792257（夜莺Night）。",
    en: "Follows the directional force-field approach of Wallpaper Engine's built-in Cursor Ripple, implemented independently here; defaults come from workshop wallpaper 3454792257 (夜莺Night).",
  },
  params: PARAMS,
  fbos: [
    { name: FIELD_A, fit: 512, unique: true },
    { name: FIELD_B, fit: 512, unique: true },
  ],
  passes: [
    { target: FIELD_A, bind: [{ name: FIELD_B, index: 0 }], alphaWriting: true, declarations: INJECT_DECL, body: INJECT_BODY },
    { target: FIELD_B, bind: [{ name: FIELD_A, index: 0 }], alphaWriting: true, declarations: SIM_DECL, body: SIM_BODY },
    {
      bind: [
        { name: FIELD_B, index: 0 },
        { name: "previous", index: 1 },
      ],
      declarations: COMBINE_DECL,
      body: COMBINE_BODY,
    },
  ],
});
