// vendor 模块统一出口：we-scene 引擎 13 个模块的 import + asAny 转型
//
// [we-scene patch] 此前 14 个 import + 13 个 asAny 转型全部堆在 main.ts 顶部；
// main.ts 拆分后（types/shell/video-loop/web/media/scene-mount/main 七模块），
// 只有 scene-mount 与 media 需要引擎，从这里按需 import，避免每个模块重复转型。
import * as pkgMod from "../vendor/we-scene/pkg/container.js";
import * as texMod from "../vendor/we-scene/pkg/texture.js";
import * as sceneMod from "../vendor/we-scene/scene/parse.js";
import * as effMod from "../vendor/we-scene/scene/effects-parse.js";
import * as rndMod from "../vendor/we-scene/render/renderer.js";
import * as noiseMod from "../vendor/we-scene/render/noise.js";
import * as particlesMod from "../vendor/we-scene/render/particles.js";
import * as particleTexMod from "../vendor/we-scene/render/particle-textures.js";
import * as mdlMod from "../vendor/we-scene/render/mdl.js";
import * as textMod from "../vendor/we-scene/render/text.js";
import * as timersMod from "../vendor/we-scene/render/engine-timers.js";
import * as audioMod from "../vendor/we-scene/render/audio.js";
import * as mediaMod from "../vendor/we-scene/render/media.js";
import * as systemMod from "../vendor/we-scene/render/system.js";
import * as animMod from "../vendor/we-scene/render/animation.js";
import * as pointerMod from "../vendor/we-scene/render/pointer.js";
import * as hitTestMod from "../vendor/we-scene/render/hittest.js";

const asAny = (m: unknown) => m as unknown as Record<string, any>;

const pkg = asAny(pkgMod);
const tex = asAny(texMod);
const scn = asAny(sceneMod);
const eff = asAny(effMod);
const rnd = asAny(rndMod);
const noise = asAny(noiseMod);
const particles = asAny(particlesMod);
const ptex = asAny(particleTexMod);
const mdl = asAny(mdlMod);
const wtext = asAny(textMod);
const wtimers = asAny(timersMod);
const media = asAny(mediaMod);
const system = asAny(systemMod);
const anim = asAny(animMod);
const pointerLib = asAny(pointerMod);
const hitTest = asAny(hitTestMod);

export {
  pkg, tex, scn, eff, rnd, noise, particles, ptex, mdl, wtext, wtimers, media, system, pointerLib, hitTest, anim, audioMod,
};
