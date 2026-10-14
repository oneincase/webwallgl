// 脚本挂点的文档读写（EDITOR-PLAN W8 / §3A P4；A8 收敛成结构化登记表）。WE 的写法是把
// 字段值包成 `{ script, scriptproperties?, value }`：value 是快照（脚本未运行 / 失败时的值），
// 与用户属性绑定 `{ user, value }`、关键帧 `{ animation, value }` 可以共存在同一个包装里。
//
// A8：挂点从「散装字符串 + 一条 EFFECT_VIS 正则」收敛成下面的 SCRIPT_HOOKS 登记表 ——
// 每个挂点族一条记录：宿主容器链 / 键 / 键匹配口径 / 可否新建 / 适用图层种类 / 引擎读点。
// locate() / scriptSlots() / addableTargets() 全部**只读表**（不再各写一份判定），
// 所以「新建脚本」菜单、scriptSlots() 读回、locate() 读写三者必然同源；表里没有的路径
// 就是非法挂点（getScript → null，setScript / removeScript → false）。
//
// 已登记的挂点族（寻址 → 引擎读点）：
//   · 对象字段   origin / scale / angles / visible / alpha / color / brightness /
//                maxwidth / pointsize / volume / intensity / exponent
//     scene/parse.js:554-568 的 objectScripts 白名单（键 → 写回槽见宿主侧
//     renderer/src/scene-mount.ts:171 scalarFieldSlot：maxwidth→textMaxwidth、
//     pointsize→textPointsize、volume→soundprops.volume、intensity/exponent→灯光；
//     变换字段在 scene-mount.ts:7177-7186，文字 color 走 textColor 拷贝 :7193-7195）。
//   · 文字内容   text（文字层的内容，不在白名单里：parse.js:492-494 单独抽 textScript）
//   · 效果开关   effects[i].visible
//   · 效果常量   effects[i].passes[p].constantshadervalues[Name]（{script, value}）
//                render/renderer.js:2007 scriptedConstants（判定 :2011 / 取值 :2017 /
//                沙箱 :2023）；键名大小写不敏感见 :731 与 :776-779；
//                render/renderer.js:2164-2182 是同一批键上的 {animation, value} 关键帧；
//                render/text.js:1907-1913 文字材质袋读的就是这个对象（getMaterial）。
//   · 粒子覆盖   instanceoverride[Name]
//                scene/parse.js:447（解析）→ :449-462 关键帧 / :470-479 脚本
//                （全库 104 段 / 29 张，音频响应粒子）
//   · 场景 general[Name]（scene.json 自身，不是图层对象）
//                scene/parse.js:844-852 generalScripts / :856-867 generalAnimations
//
// 只读标注：general.* / instanceoverride.* / 效果常量的**键名**由场景自由取用，引擎侧
// 没有静态白名单，所以这三族用通配键登记（`general.{name}`）：能按路径读写（读回 /
// 改写 / 去脚本都不丢同族的 animation 与 scriptproperties），但「新建脚本」菜单列不出
// 候选键，只能由已知路径（脚本控制台 / 插件 / 效果参数面板）驱动。其中只有
// `general.{name}` 允许按请求名**新建**键（场景字段本来就是作者自定义的）；
// 效果常量 / 粒子覆盖的键必须已经存在 —— 材质名不在袋里、覆盖键不是引擎认的那几个，
// 造出来写进 scene.json 也不生效，所以 setScript 直接返回 false。效果常量的
// `{animation, value}` 键本表只保证**不丢**，关键帧 UI 归关键帧车道。

import type { SceneObject } from "./doc";

/** 容器链上的一步：怎么从对象走到「装着挂点的宿主容器」 */
type HookStep =
  | { of: "self" }
  | { of: "box"; key: string }
  | { of: "array"; key: string; idx: string };

/** 通配键的匹配口径：敏感（一般键名）/ 不敏感（效果常量 —— 引擎就是大小写不敏感的） */
type KeyPolicy = "exact" | "insensitive";

type HookDef = {
  /** 稳定 id（诊断 / 判据用，不写进 scene.json） */
  id: string;
  /** 链尾的键：字面量（一个容器一个挂点）或占位符（枚举容器里已有的全部键） */
  key: { literal: string } | { wildcard: string };
  /** 从对象走到宿主容器的链 */
  chain: readonly HookStep[];
  keyPolicy: KeyPolicy;
  /** 能否出现在「新建脚本」菜单里（通配键列不出候选 ⇒ 只登记不新建） */
  addable?: boolean;
  /** 只在 scene.json 自身命中（objects 是数组的才算场景，图层对象不认） */
  sceneOnly?: boolean;
  /** 对象字段：进 OBJECT_SCRIPT_FIELDS（引擎白名单的那 12 项） */
  objectField?: boolean;
  /** 适用图层种类白名单 */
  kinds?: readonly string[];
  /** 反向口径：除这些种类外都适用（插件登记的未知种类也含在内） */
  except?: readonly string[];
  /** 就地包装时写进 .value 的快照缺省值 */
  fallback?: unknown;
  /** 通配键在容器里不存在时，是否按请求名建立（只有作者自由定义的 general 需要） */
  createKey?: boolean;
  /** 脚本模板 @param 的 JS 类型 */
  jsType?: string;
  /** 引擎读点 / 口径标注 */
  note?: string;
};

export type ScriptHook = HookDef & {
  /** 面板 / 日志里的寻址字符串（由 chain + key 生成；{i} {p} {name} 是占位符） */
  path: string;
};

const SELF: readonly HookStep[] = [{ of: "self" }];

/** 对象通用字段（origin/scale/angles/visible/alpha）的适用种类：除声音（只有 volume）
 *  与灯光（只有 color/intensity/exponent）外都适用；插件登记的未知种类也走这条。 */
const OBJ_FIELD_EXCEPT = ["sound", "light"] as const;
const COLOR_KINDS = ["image", "container", "fullscreen-post", "text", "light"] as const;
const BRIGHTNESS_KINDS = ["image", "container", "fullscreen-post", "text"] as const;

/** 通用对象字段（objectScripts 前 5 项）的统一口径标注 */
const OBJ_FIELD_NOTE =
  "对象字段脚本：parse.js:554-568 白名单；宿主逐帧求值后写回图层（scene-mount.ts:7171 取写回槽 / :7177-7186 变换字段）";

const HOOK_DEFS: readonly HookDef[] = [
  // ── 对象字段（scene/parse.js:554-568 白名单 12 项 + text 单列）──────────────
  {
    id: "text",
    chain: SELF,
    key: { literal: "text" },
    keyPolicy: "exact",
    addable: true,
    kinds: ["text"],
    fallback: "",
    jsType: "String",
    note: "文字层内容；引擎单独抽 textScript（parse.js:492-494），不在 objectScripts 白名单里",
  },
  { id: "origin", chain: SELF, key: { literal: "origin" }, keyPolicy: "exact", addable: true, objectField: true, except: OBJ_FIELD_EXCEPT, fallback: "0.00000 0.00000 0.00000", jsType: "Vec3", note: OBJ_FIELD_NOTE },
  { id: "scale", chain: SELF, key: { literal: "scale" }, keyPolicy: "exact", addable: true, objectField: true, except: OBJ_FIELD_EXCEPT, fallback: "1.00000 1.00000 1.00000", jsType: "Vec3", note: OBJ_FIELD_NOTE },
  { id: "angles", chain: SELF, key: { literal: "angles" }, keyPolicy: "exact", addable: true, objectField: true, except: OBJ_FIELD_EXCEPT, fallback: "0.00000 0.00000 0.00000", jsType: "Vec3", note: OBJ_FIELD_NOTE },
  { id: "visible", chain: SELF, key: { literal: "visible" }, keyPolicy: "exact", addable: true, objectField: true, except: OBJ_FIELD_EXCEPT, fallback: true, jsType: "Boolean", note: OBJ_FIELD_NOTE },
  { id: "alpha", chain: SELF, key: { literal: "alpha" }, keyPolicy: "exact", addable: true, objectField: true, except: OBJ_FIELD_EXCEPT, fallback: 1, jsType: "Number", note: OBJ_FIELD_NOTE },
  { id: "color", chain: SELF, key: { literal: "color" }, keyPolicy: "exact", addable: true, objectField: true, kinds: COLOR_KINDS, fallback: "1.00000 1.00000 1.00000", jsType: "Vec3", note: `${OBJ_FIELD_NOTE}；文字层颜色另有 textColor 特例（scene-mount.ts:7193-7195）` },
  { id: "brightness", chain: SELF, key: { literal: "brightness" }, keyPolicy: "exact", addable: true, objectField: true, kinds: BRIGHTNESS_KINDS, fallback: 1, jsType: "Number", note: `${OBJ_FIELD_NOTE}；亮度是对象字段，不是效果常量` },
  { id: "maxwidth", chain: SELF, key: { literal: "maxwidth" }, keyPolicy: "exact", addable: true, objectField: true, kinds: ["text"], fallback: 0, jsType: "Number", note: "文字限宽；写回槽 textMaxwidth（scene-mount.ts:172-177），parse.js:516 缺省 0" },
  { id: "pointsize", chain: SELF, key: { literal: "pointsize" }, keyPolicy: "exact", addable: true, objectField: true, kinds: ["text"], fallback: 24, jsType: "Number", note: "文字字号；写回槽 textPointsize（scene-mount.ts:178-180），parse.js:498 缺省 24" },
  { id: "volume", chain: SELF, key: { literal: "volume" }, keyPolicy: "exact", addable: true, objectField: true, kinds: ["sound"], fallback: 1, jsType: "Number", note: "声音层音量；写回槽 soundprops.volume（scene-mount.ts:181-186），parse.js:483 缺省 1" },
  { id: "intensity", chain: SELF, key: { literal: "intensity" }, keyPolicy: "exact", addable: true, objectField: true, kinds: ["light"], fallback: 1, jsType: "Number", note: "灯光强度（parse.js:596 缺省 1）；不是粒子参数" },
  { id: "exponent", chain: SELF, key: { literal: "exponent" }, keyPolicy: "exact", addable: true, objectField: true, kinds: ["light"], fallback: 2, jsType: "Number", note: "灯光衰减指数（parse.js:599-600 缺省 2，只有 V1 通道的灯吃它）" },

  // ── 效果开关：effects[i] ──────────────────────────────────────────────────
  {
    id: "effect.visible",
    chain: [{ of: "array", key: "effects", idx: "i" }],
    key: { literal: "visible" },
    keyPolicy: "exact",
    note: "效果条目自身的显隐（宿主按 isEffectVisible 读 .value）",
  },

  // ── 效果常量：effects[i].passes[p].constantshadervalues[Name] ──────────────
  {
    id: "effect.constant",
    chain: [
      { of: "array", key: "effects", idx: "i" },
      { of: "array", key: "passes", idx: "p" },
      { of: "box", key: "constantshadervalues" },
    ],
    key: { wildcard: "name" },
    keyPolicy: "insensitive",
    note: "只改 .value，scriptproperties / animation 原样保留；键名大小写不敏感（renderer.js:731/:776）",
  },

  // ── 粒子实例覆盖：instanceoverride[Name] ─────────────────────────────────
  {
    id: "particle.override",
    chain: [{ of: "box", key: "instanceoverride" }],
    key: { wildcard: "name" },
    keyPolicy: "exact",
    note: "rate / colorn / count / size / alpha 等覆盖键（parse.js:470-479 脚本 / :449-462 关键帧）",
  },

  // ── 场景 general[Name]（scene.json 自身，不是图层字段）─────────────────────
  {
    id: "scene.general",
    chain: [{ of: "box", key: "general" }],
    key: { wildcard: "name" },
    keyPolicy: "exact",
    sceneOnly: true,
    createKey: true,
    note: "zoom / bloomstrength / cameraparallax 等（parse.js:844-852 脚本 / :856-867 关键帧）",
  },
];

/** 挂点登记表（A8 的唯一真相）：path 由 chain + key 生成，其余字段见 HookDef */
export const SCRIPT_HOOKS: readonly ScriptHook[] = HOOK_DEFS.map((d) => ({ ...d, path: pathOf(d) }));

/** 引擎解析的对象脚本字段白名单（同 scene/parse.js:554-568 的 objectScripts；text 单列） */
export const OBJECT_SCRIPT_FIELDS: readonly string[] = HOOK_DEFS.filter((d) => d.objectField && "literal" in d.key).map(
  (d) => (d.key as { literal: string }).literal,
);

function stepPath(s: HookStep): string {
  return s.of === "self" ? "" : s.of === "box" ? s.key : `${s.key}[{${s.idx}}]`;
}

/** 由链与键生成寻址字符串（`{i}` / `{p}` / `{name}` 是占位符）
 *  链只走 box / 数组元素，链尾容器一定是对象 ⇒ 尾键永远用点号（`…constantshadervalues[{name}]`
 *  这种下标写法是错的：键是材质名，不是数组元素）。 */
function pathOf(d: HookDef): string {
  const head = d.chain.map(stepPath).filter(Boolean).join(".");
  const tail = "literal" in d.key ? d.key.literal : `{${d.key.wildcard}}`;
  return head ? `${head}.${tail}` : tail;
}

/** 链上的数组下标占位符名（正则里按数字捕获，键占位符才允许任意字符） */
const idxNamesOf = (d: HookDef): Set<string> => new Set(d.chain.filter((s) => s.of === "array").map((s) => (s as { idx: string }).idx));

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matchers = new Map<string, { re: RegExp; names: string[] }>();

/** 寻址字符串 → 正则。下标占位符捕获 `\d+`；键占位符捕获 `.+` —— 真语料里材质名
 *  **会带方括号**（如 `[P1] Semi-major|长半轴`），用 `[^\[\]]+` 会把这一族整片读不到
 *  （本文件就是被 scripts/verify-script-hooks.mjs 的语料覆盖判据抓出来的）。 */
function matcher(d: ScriptHook): { re: RegExp; names: string[] } {
  let hit = matchers.get(d.path);
  if (!hit) {
    const idxNames = idxNamesOf(d);
    const names: string[] = [];
    const src = escapeRe(d.path).replace(/\\\{([A-Za-z_]\w*)\\\}/g, (_all, n: string) => {
      names.push(n);
      return idxNames.has(n) ? "(\\d+)" : "(.+)";
    });
    hit = { re: new RegExp(`^${src}$`), names };
    matchers.set(d.path, hit);
  }
  return hit;
}

const renderPath = (path: string, params: Record<string, string>): string => path.replace(/\{(\w+)\}/g, (all, k: string) => params[k] ?? all);

/** 路径 → 登记表条目 + 占位符实参（未登记 = null） */
function matchHook(target: string): { def: ScriptHook; params: Record<string, string> } | null {
  for (const def of SCRIPT_HOOKS) {
    const { re, names } = matcher(def);
    const m = re.exec(target);
    if (!m) continue;
    const params: Record<string, string> = {};
    names.forEach((n, i) => {
      params[n] = m[i + 1];
    });
    return { def, params };
  }
  return null;
}

export type ScriptSlot = {
  target: string;
  script: string;
  /** 包装里的快照值 */
  value: unknown;
  hasProps: boolean;
};

type Wrapped = { script?: unknown; scriptproperties?: unknown; value?: unknown; [k: string]: unknown };

const box = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const isBox = (v: unknown): boolean => box(v) !== null;

/** 字段包装（与 doc.ts 的 isFieldWrapper 同口径）：脚本 / 用户属性 / 关键帧 / 快照值任一在，就是包装 */
const isWrapper = (v: unknown): v is Wrapped => {
  const b = box(v);
  if (!b) return false;
  if ("script" in b || "user" in b || "value" in b) return true;
  const anim = box(b.animation);
  return !!anim && "options" in anim;
};

const scriptOf = (v: unknown): string | null => {
  const b = box(v);
  return b && typeof b.script === "string" && b.script ? b.script : null;
};

/** 沿容器链走到宿主容器；create=true 时按需补出缺的中间 box（数组元素不新建） */
function containerOf(
  obj: SceneObject,
  def: ScriptHook,
  params: Record<string, string>,
  create: boolean,
  created?: Array<{ host: Record<string, unknown>; key: string }>,
): Record<string, unknown> | null {
  let cur: Record<string, unknown> | null = obj as Record<string, unknown>;
  for (const s of def.chain) {
    if (s.of === "self") continue;
    if (!cur) return null;
    const next = cur[s.key];
    if (s.of === "box") {
      const b = box(next);
      if (b) {
        cur = b;
        continue;
      }
      // 只在**键缺失**时新建容器；已经存在的非容器值（作者写了字符串 / null）不覆盖，
      // 覆盖了就是拿编辑器的心智模型去改作者的数据。
      if (!create || next !== undefined) return null;
      const fresh: Record<string, unknown> = {};
      created?.push({ host: cur, key: s.key });
      cur[s.key] = fresh;
      cur = fresh;
      continue;
    }
    const idx = Number(params[s.idx]);
    if (!Array.isArray(next) || !Number.isInteger(idx) || idx < 0 || idx >= next.length) return null;
    cur = box(next[idx]);
  }
  return cur;
}

/** 容器里的实际键：字面量直接用；通配键按口径找已有键。
 *  找不到时只有 `createKey` 的族（场景 general —— 键由作者自由取用）才按请求名新建；
 *  效果常量 / 粒子覆盖的键必须已经存在：材质名不在袋里、覆盖键不是引擎认的那几个，
 *  凭空造出来只会往 scene.json 写一个引擎不读的字段（写进去也不生效，不如直接 false）。 */
function keyIn(host: Record<string, unknown>, def: ScriptHook, params: Record<string, string>, create: boolean): string | null {
  if ("literal" in def.key) return def.key.literal;
  const want = params[def.key.wildcard];
  if (!want) return null;
  if (def.keyPolicy === "insensitive") {
    const lower = want.toLowerCase();
    for (const k of Object.keys(host)) if (k.toLowerCase() === lower) return k;
  } else if (Object.prototype.hasOwnProperty.call(host, want)) {
    return want;
  }
  return create && def.createKey ? want : null;
}

/** 挂点 → 宿主容器 + 键（create=true 时按登记表补出缺的容器 / 通配键）
 *
 *  create=true 也**不留下失败副作用**：先照常解析并新建，键最终定位不到时把本次新建的
 *  容器按后进先出撤掉。这条不是洁癖 —— `setScript` 的契约是「返回 false = 文档一个字没动」，
 *  留下一个空的 `constantshadervalues: {}` 会让 scene.json 写出没用的字段、还会污染撤销步。 */
function locate(obj: SceneObject, target: string, create = false): { host: Record<string, unknown>; key: string; def: ScriptHook } | null {
  const hit = matchHook(target);
  if (!hit) return null;
  if (hit.def.sceneOnly && !Array.isArray((obj as Record<string, unknown>).objects)) return null;
  const created: Array<{ host: Record<string, unknown>; key: string }> = [];
  const host = containerOf(obj, hit.def, hit.params, create, created);
  const key = host ? keyIn(host, hit.def, hit.params, create) : null;
  if (host && key !== null) return { host, key, def: hit.def };
  for (let i = created.length - 1; i >= 0; i--) delete created[i].host[created[i].key];
  return null;
}

/** 适用种类：白名单优先，其次反向口径，都没有就是不限 */
const appliesTo = (def: ScriptHook, kind: string): boolean => (def.kinds ? def.kinds.includes(kind) : def.except ? !def.except.includes(kind) : true);

/** 新建脚本时面板提供的挂点（登记表里 addable + 字面量键的那些，按表序） */
export function addableTargets(kind: string): string[] {
  return SCRIPT_HOOKS.filter((d) => d.addable && "literal" in d.key && appliesTo(d, kind)).map((d) => d.path);
}

/** 沿容器链枚举全部实例（数组链按元素展开，`{i}` / `{p}` 由下标填） */
function walk(
  host: Record<string, unknown>,
  chain: readonly HookStep[],
  si: number,
  params: Record<string, string>,
  emit: (host: Record<string, unknown>, params: Record<string, string>) => void,
): void {
  if (si >= chain.length) {
    emit(host, params);
    return;
  }
  const s = chain[si];
  if (s.of === "self") {
    walk(host, chain, si + 1, params, emit);
    return;
  }
  const next = host[s.key];
  if (s.of === "box") {
    const b = box(next);
    if (b) walk(b, chain, si + 1, params, emit);
    return;
  }
  if (!Array.isArray(next)) return;
  for (let i = 0; i < next.length; i++) {
    const b = box(next[i]);
    if (b) walk(b, chain, si + 1, { ...params, [s.idx]: String(i) }, emit);
  }
}

/** 一个挂点族在对象上的全部实例（通配键展开成容器里已有的键） */
function hookInstances(obj: SceneObject, def: ScriptHook): Array<{ target: string; host: Record<string, unknown>; key: string }> {
  const out: Array<{ target: string; host: Record<string, unknown>; key: string }> = [];
  if (def.sceneOnly && !Array.isArray((obj as Record<string, unknown>).objects)) return out;
  const emit = (host: Record<string, unknown>, params: Record<string, string>): void => {
    if ("literal" in def.key) {
      out.push({ target: renderPath(def.path, params), host, key: def.key.literal });
      return;
    }
    for (const k of Object.keys(host)) {
      out.push({ target: renderPath(def.path, { ...params, [def.key.wildcard]: k }), host, key: k });
    }
  };
  walk(obj as Record<string, unknown>, def.chain, 0, {}, emit);
  return out;
}

/** 图层（或场景）上已有的脚本，按登记表顺序 */
export function scriptSlots(obj: SceneObject): ScriptSlot[] {
  const out: ScriptSlot[] = [];
  for (const def of SCRIPT_HOOKS) {
    for (const at of hookInstances(obj, def)) {
      const v = at.host[at.key];
      const s = scriptOf(v);
      if (s !== null) out.push({ target: at.target, script: s, value: (v as Wrapped).value, hasProps: isBox((v as Wrapped).scriptproperties) });
    }
  }
  return out;
}

export function getScript(obj: SceneObject, target: string): string | null {
  const at = locate(obj, target);
  return at ? scriptOf(at.host[at.key]) : null;
}

/** 写脚本源码；字段原本是裸值 / {user,value} / {animation,value} 时就地包装，绑定与快照保留 */
export function setScript(obj: SceneObject, target: string, code: string): boolean {
  if (typeof code !== "string" || !code.trim()) return false;
  const at = locate(obj, target, true);
  if (!at) return false;
  const cur = at.host[at.key];
  if (isWrapper(cur)) {
    if (cur.script === code) return false;
    cur.script = code;
    return true;
  }
  at.host[at.key] = { script: code, value: cur ?? at.def.fallback };
  return true;
}

/** 去掉脚本：只剩 value 时解包回裸值，还有用户属性绑定 / 关键帧时就保留包装 */
export function removeScript(obj: SceneObject, target: string): boolean {
  const at = locate(obj, target);
  const cur = at ? at.host[at.key] : undefined;
  if (!at || !isWrapper(cur) || scriptOf(cur) === null) return false;
  delete cur.script;
  delete cur.scriptproperties;
  const rest = Object.keys(cur).filter((k) => k !== "value");
  at.host[at.key] = rest.length ? cur : cur.value;
  if (at.host[at.key] === undefined) delete at.host[at.key];
  return true;
}

/**
 * 脚本生命周期模板（B8 / M9）。
 * 入口名字面量依据引擎：`renderer/vendor/we-scene/render/text.js` 的 `SCRIPT_ENTRY_NAMES`
 * （`update` / `init` / `applyUserProperties` / 6 个 `cursor*` / `MEDIA_CALLBACKS` 6 个 /
 * `animationEvent` / `resizeScreen`）。派发口径同文件：`init(value)` 的返回值是字段新初值、
 * `applyUserProperties(props)` 挂载时以全量属性先调一次、`callCursor(name, event)` 传单个事件、
 * `callMedia(name, event)` 传 toScriptMediaEvent(event)、`animationEvent(event, value)` 两个参数、
 * `resizeScreen(size)` 单个 Vec2。
 * `destroy` **不在** `SCRIPT_ENTRY_NAMES` 里（引擎只有 `thisScene.destroyLayer` 的墓碑机制），
 * 所以它的模板额外保留字段主回调，免得整份脚本被「无可用入口」的闸门丢掉。
 */
export type ScriptLifecycle =
  | "update"
  | "init"
  | "applyUserProperties"
  | "cursor"
  | "media"
  | "resizeScreen"
  | "animationEvent"
  | "destroy";

/** 面板下拉里的模板顺序：先字段主回调，再按引擎派发顺序，destroy 排最后（引擎不派发） */
export const SCRIPT_LIFECYCLES: readonly ScriptLifecycle[] = [
  "update",
  "init",
  "applyUserProperties",
  "cursor",
  "media",
  "resizeScreen",
  "animationEvent",
  "destroy",
];

/** 字段类型取登记表（未登记的挂点回落 Number，模板仍可用） */
function fieldType(target: string): string {
  return matchHook(target)?.def.jsType ?? "Number";
}

/** 字段主回调：参数是字段当前值，返回值即新值（undefined = 保持不变） */
function fieldUpdate(target: string): string {
  return [
    "/**",
    ` * ${target}`,
    ` * @param {${fieldType(target)}} value 字段当前值`,
    " * @returns 字段新值；返回 undefined 表示保持不变",
    " */",
    "export function update(value) {",
    "\treturn value;",
    "}",
  ].join("\n");
}

/** 除 update 之外的生命周期钩子（每个模板都会再带上一段字段主回调） */
function lifecycleHook(kind: Exclude<ScriptLifecycle, "update">): string {
  switch (kind) {
    case "init":
      return [
        "/**",
        " * 挂载时调用一次；返回值是该字段的新初值（不返回则保持 scene.json 里的值）。",
        " */",
        "export function init(value) {",
        "\treturn value;",
        "}",
      ].join("\n");
    case "applyUserProperties":
      return [
        "/**",
        " * 用户属性变化；挂载时会先用全量属性调一次。props 形如 { 属性名: 值 }。",
        " */",
        "export function applyUserProperties(props) {",
        "\t// 例：thisLayer.text = props.标题",
        "}",
      ].join("\n");
    case "cursor":
      return [
        "// 指针事件：引擎按事件名逐个派发（hittest / cursor-dispatch），只留用得上的那几个即可。",
        "export function cursorClick(e) {}",
        "export function cursorEnter(e) {}",
        "export function cursorLeave(e) {}",
        "export function cursorDown(e) {}",
        "export function cursorUp(e) {}",
        "export function cursorMove(e) {}",
      ].join("\n");
    case "media":
      return [
        "// 媒体回调：宿主只在媒体快照变化时派发（不是每帧），e 形如 { title, artist, ... }。",
        "export function mediaPropertiesChanged(e) {}",
        "export function mediaThumbnailChanged(e) {}",
        "export function mediaPlaybackChanged(e) {}",
        "export function mediaTimelineChanged(e) {}",
        "export function mediaStatusChanged(e) {}",
        "export function mediaLyricsChanged(e) {}",
      ].join("\n");
    case "resizeScreen":
      return [
        "/**",
        " * 画布尺寸变化（含首帧）；size 是 Vec2，读 size.x / size.y。",
        " */",
        "export function resizeScreen(size) {}",
      ].join("\n");
    case "animationEvent":
      return [
        "/**",
        " * 动画帧事件：该图层任一动画出事件时广播；value 是本字段当前值，返回值可覆盖它。",
        " */",
        "export function animationEvent(event, value) {",
        "\treturn value;",
        "}",
      ].join("\n");
    case "destroy":
      return [
        "// destroy 不是引擎派发的入口（SCRIPT_ENTRY_NAMES 里没有它）。这里只留一个清理位，",
        "// 并按官方惯例保留字段主回调：没有可用入口、又不读 engine 时钟的脚本会被整份丢弃。",
        "export function destroy() {}",
      ].join("\n");
  }
}

/**
 * 新脚本模板。lifecycle 缺省 `"update"`（WE 官方的 update(value) 形态，返回值即字段新值）；
 * 其余模板 = 所选生命周期钩子 + 字段主回调。
 */
export function scriptTemplate(target: string, lifecycle: ScriptLifecycle = "update"): string {
  const head = "'use strict';\n\n";
  if (lifecycle === "update") return `${head}${fieldUpdate(target)}\n`;
  return `${head}${lifecycleHook(lifecycle)}\n\n${fieldUpdate(target)}\n`;
}
