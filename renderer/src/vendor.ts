// we-scene 引擎统一出口（asAny 转型一次，scene-mount / media 按需引用）
import * as pkgMod from "../vendor/we-scene/pkg/container.js";
import * as texMod from "../vendor/we-scene/pkg/texture.js";
import * as sceneMod from "../vendor/we-scene/scene/parse.js";
import * as effMod from "../vendor/we-scene/scene/effects-parse.js";
import * as rndMod from "../vendor/we-scene/render/renderer.js";
import * as noiseMod from "../vendor/we-scene/render/noise.js";
import * as particlesMod from "../vendor/we-scene/render/particles.js";
import * as particleTexMod from "../vendor/we-scene/render/particle-textures.js";
import * as sysTexMod from "../vendor/we-scene/render/system-textures.js";
import * as gradientTexMod from "../vendor/we-scene/render/gradient-textures.js";
import * as patternTexMod from "../vendor/we-scene/render/pattern-textures.js";
import * as mdlMod from "../vendor/we-scene/render/mdl.js";
import * as textMod from "../vendor/we-scene/render/text.js";
import * as timersMod from "../vendor/we-scene/render/engine-timers.js";
import * as audioMod from "../vendor/we-scene/render/audio.js";
import * as mediaMod from "../vendor/we-scene/render/media.js";
import * as systemMod from "../vendor/we-scene/render/system.js";
import * as animMod from "../vendor/we-scene/render/animation.js";
import * as pointerMod from "../vendor/we-scene/render/pointer.js";
import * as hitTestMod from "../vendor/we-scene/render/hittest.js";
import * as cursorDispatchMod from "../vendor/we-scene/render/cursor-dispatch.js";

const asAny = (m: unknown) => m as unknown as Record<string, any>;

const pkg = asAny(pkgMod);
const tex = asAny(texMod);
const scn = asAny(sceneMod);
const eff = asAny(effMod);
const rnd = asAny(rndMod);
const noise = asAny(noiseMod);
const particles = asAny(particlesMod);
const ptex = asAny(particleTexMod);
const sysTex = asAny(sysTexMod);
const gtex = asAny(gradientTexMod);
const patTex = asAny(patternTexMod);
const mdl = asAny(mdlMod);
const wtext = asAny(textMod);
const wtimers = asAny(timersMod);
const media = asAny(mediaMod);
const system = asAny(systemMod);
const anim = asAny(animMod);
const pointerLib = asAny(pointerMod);
const hitTest = asAny(hitTestMod);
const cursorDispatch = asAny(cursorDispatchMod);

export {
  pkg, tex, scn, eff, rnd, noise, particles, ptex, sysTex, gtex, patTex, mdl, wtext, wtimers, media, system, pointerLib, hitTest, cursorDispatch, anim, audioMod,
};
