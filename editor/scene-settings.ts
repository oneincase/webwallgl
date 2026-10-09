// 「场景设置」面板（计划 A4）：把只存在于作者壁纸 scene.json 里的 general 参数做成可编辑面板。
//
// 与「渲染选项」划清界限（计划里专门点了这条，别混成一个面板）：
//   · 渲染选项（editor/ui/render-settings.ts）= 本机 UI 偏好：帧率上限 / 画质 / 音量 / 系统音频。
//     存 localStorage、所有文档共用、不写进工程文件。
//   · 场景设置（本文件）= 这份壁纸自己的参数：写进工程 scene.json 的 general 段、进文档、
//     改一次进一次撤销栈（范式同工程改名 TitleCmd）。
//
// 字段表按计划 §1.3 的命中率挑（358 个工程里出现最多的那些，键名是 WE 原样的小写无分隔写法）。
// 面板只写列出来的键；其余键（面板不认识的未知键、orthogonalprojection、camerapreview、
// 带 script / animation 的包装）由 editor/doc.ts 的 readGeneralField / writeGeneralField 带过去。

import { readGeneralField, sceneGeneral } from "./doc";
import { et } from "./i18n";

export type SceneFieldKind = "bool" | "num" | "int" | "color";

export type SceneField = {
  /** general 里的键名（WE 原样，全小写） */
  key: string;
  kind: SceneFieldKind;
  /** WE 编辑器给新工程的默认值：只用来显示「未设置 / 默认」，绝不据此删键或改键 */
  def: unknown;
  min?: number;
  max?: number;
  step?: number;
  /** 分组 id，对应文案 scn.sec.<id> */
  group: string;
};

/** 分组顺序就是面板里的顺序 */
export const SCENE_GROUPS = ["clear", "camera", "shake", "parallax", "bloom"] as const;

/** 颜色按 WE 的写法落盘：三个空格分隔的定点小数字符串 */
const COLOR_DIGITS = 5;

export const SCENE_FIELDS: readonly SceneField[] = [
  // 清屏与环境光
  { key: "clearenabled", kind: "bool", def: true, group: "clear" },
  { key: "clearcolor", kind: "color", def: "0.70000 0.70000 0.70000", group: "clear" },
  { key: "ambientcolor", kind: "color", def: "0.30000 0.30000 0.30000", group: "clear" },
  { key: "skylightcolor", kind: "color", def: "0.30000 0.30000 0.30000", group: "clear" },
  // 相机
  { key: "fov", kind: "num", def: 50, min: 1, max: 179, step: 1, group: "camera" },
  { key: "nearz", kind: "num", def: 0.01, min: 0.0001, step: 0.01, group: "camera" },
  { key: "farz", kind: "num", def: 10000, min: 0.1, step: 100, group: "camera" },
  { key: "zoom", kind: "num", def: 1, min: 0.01, step: 0.05, group: "camera" },
  // WE 只在 > 0 时才拿它盖掉按高度反推的 FOV，0 = 不覆盖（renderer/vendor/we-scene/render/math.js）
  { key: "perspectiveoverridefov", kind: "num", def: 0, min: 0, max: 179, step: 1, group: "camera" },
  { key: "camerafade", kind: "bool", def: false, group: "camera" },
  { key: "camerapreview", kind: "bool", def: false, group: "camera" },
  // 相机抖动
  { key: "camerashake", kind: "bool", def: false, group: "shake" },
  { key: "camerashakeamplitude", kind: "num", def: 0.5, min: 0, step: 0.05, group: "shake" },
  { key: "camerashakeroughness", kind: "num", def: 1, min: 0, max: 2, step: 0.05, group: "shake" },
  { key: "camerashakespeed", kind: "num", def: 3, min: 0, step: 0.1, group: "shake" },
  // 鼠标视差（键名是 cameraparallaxdelay，不是 delay；cameraparallaxmouseinfluence 不是 mouseinfluence）
  { key: "cameraparallax", kind: "bool", def: false, group: "parallax" },
  { key: "cameraparallaxamount", kind: "num", def: 0.5, min: 0, step: 0.05, group: "parallax" },
  { key: "cameraparallaxdelay", kind: "num", def: 0.1, min: 0, step: 0.01, group: "parallax" },
  { key: "cameraparallaxmouseinfluence", kind: "num", def: 0, min: 0, step: 0.05, group: "parallax" },
  // 泛光 / HDR（hdr=false 走经典一族 bloomstrength / bloomthreshold，true 走 bloomhdr* 一族）
  { key: "bloom", kind: "bool", def: false, group: "bloom" },
  { key: "bloomstrength", kind: "num", def: 2, min: 0, step: 0.05, group: "bloom" },
  { key: "bloomthreshold", kind: "num", def: 0.65, min: 0, max: 1, step: 0.01, group: "bloom" },
  { key: "bloomtint", kind: "color", def: "1 1 1", group: "bloom" },
  { key: "hdr", kind: "bool", def: false, group: "bloom" },
  { key: "bloomhdrstrength", kind: "num", def: 2, min: 0, step: 0.05, group: "bloom" },
  { key: "bloomhdrthreshold", kind: "num", def: 1, min: 0, step: 0.01, group: "bloom" },
  { key: "bloomhdrscatter", kind: "num", def: 1.619, min: 0, step: 0.01, group: "bloom" },
  { key: "bloomhdrfeather", kind: "num", def: 0.1, min: 0, step: 0.01, group: "bloom" },
  { key: "bloomhdriterations", kind: "int", def: 8, min: 1, max: 16, step: 1, group: "bloom" },
];

export const sceneField = (key: string): SceneField | undefined => SCENE_FIELDS.find((f) => f.key === key);

/** 颜色 "r g b" → 三个有限数；分量数不对 / 有非数字给 null */
export function parseColor(text: string): number[] | null {
  const parts = text.trim().split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 3) return null;
  const nums = parts.map(Number);
  return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/** 颜色落盘：与 WE 自己写的一致（五个小数、空格分隔） */
export const formatColor = (nums: readonly number[]): string => nums.map((n) => n.toFixed(COLOR_DIGITS)).join(" ");

/**
 * 输入框文本 → 要写进 general 的值。认不出来给 null（调用方原样退回，不动文档）。
 * 数值按 WE 的语义存 number，不存字符串；整数族四舍五入。
 */
export function parseSceneValue(field: SceneField, text: string): unknown | null {
  const raw = text.trim();
  if (field.kind === "color") {
    const nums = parseColor(raw);
    return nums ? formatColor(nums) : null;
  }
  if (raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (field.kind === "int") return Math.round(n);
  if (field.min !== undefined && n < field.min) return null;
  if (field.max !== undefined && n > field.max) return null;
  return n;
}

/** 面板显示的文本（读取用；认不出来的形状原样 String 出来，别假装看得懂） */
export function formatSceneValue(field: SceneField, value: unknown): string {
  if (field.kind === "color") {
    if (typeof value === "string") {
      const nums = parseColor(value);
      return nums ? formatColor(nums) : value;
    }
    if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number")) {
      return formatColor(value as number[]);
    }
    return String(value);
  }
  if (field.kind === "bool") return value === true || value === 1 ? "true" : "false";
  return typeof value === "number" ? String(value) : String(value);
}

/**
 * 面板一行：字段 + 当前作者值（拆掉脚本 / 动画包装）+ 这个键在 general 里在不在。
 * present=false 表示文档里没这个键 —— 引擎走自己的默认值，面板不替作者补键。
 */
export type SceneRow = { field: SceneField; present: boolean; value: unknown; wrapped: boolean };

export function sceneRows(scene: Record<string, unknown> | null): SceneRow[] {
  const general = sceneGeneral(scene);
  return SCENE_FIELDS.map((field) => {
    const raw = general[field.key];
    const wrapped = !!raw && typeof raw === "object" && !Array.isArray(raw) && ("script" in raw || "animation" in raw);
    return { field, present: field.key in general, value: readGeneralField(general, field.key), wrapped };
  });
}

export type SceneSettingsOptions = {
  /** 面板字段内容的宿主（#scene-menu-body） */
  root: HTMLElement;
  /** 当前文档的 scene（没有文档返回 null，面板整块置灰） */
  scene: () => Record<string, unknown> | null;
  /** 落地一次编辑：改 general + 进撤销栈。返回 false = 没改成（值没变 / 没有文档） */
  edit: (label: string, key: string, value: unknown) => boolean;
  /** 输入认不出来时提示用户（可选） */
  bad?: (msg: string) => void;
};

export type SceneSettings = {
  /** 换文档 / 撤销重做 / 切语言后重画（菜单每次打开也会调一次） */
  refresh(): void;
};

/**
 * 字段控件的公共部分：一行 `.wb-field`（沿用全局渲染菜单的排版），
 * 右边 `.wb-field-val` 只报状态（默认 / 已设），不重复输入框里的值。
 */
function mountSceneSettings(opts: SceneSettingsOptions): SceneSettings {
  const { root } = opts;

  const badge = (row: SceneRow) => {
    const val = document.createElement("span");
    val.className = "wb-field-val";
    val.textContent = row.present ? et("scn.set") : et("scn.def");
    if (row.wrapped) val.textContent += ` · ${et("scn.wrapped")}`;
    return val;
  };

  const commit = (field: SceneField, value: unknown, back: () => void) => {
    const label = et("log.sceneSet", { name: et(`scn.f.${field.key}`), value: formatSceneValue(field, value) });
    if (!opts.edit(label, field.key, value)) back();
    refresh();
  };

  const fieldRow = (row: SceneRow): HTMLElement => {
    const { field, present, value } = row;
    const line = document.createElement("label");
    line.className = "wb-field";
    line.dataset.etTitle = `scn.f.${field.key}`;
    line.dataset.sceneKey = field.key; // 端到端用例按键定位控件（见 verify-editor-headless.mjs 的 AK 段）
    line.title = `${field.key}${present ? "" : `（未设置，默认 ${formatSceneValue(field, field.def)}）`}`;
    const name = document.createElement("span");
    name.className = "wb-field-label";
    name.dataset.et = `scn.f.${field.key}`;
    name.textContent = et(`scn.f.${field.key}`);
    const ctl = document.createElement("span");
    ctl.className = "wb-field-ctl";
    line.append(name, ctl);

    if (field.kind === "bool") {
      const inp = document.createElement("input");
      inp.type = "checkbox";
      inp.checked = value === true || value === 1;
      inp.addEventListener("change", () => commit(field, inp.checked, () => (inp.checked = !inp.checked)));
      ctl.append(inp, badge(row));
      return line;
    }
    const inp = document.createElement("input");
    if (field.kind === "color") {
      inp.type = "text";
      inp.spellcheck = false;
      inp.placeholder = formatSceneValue(field, field.def);
    } else {
      inp.type = "number";
      if (field.min !== undefined) inp.min = String(field.min);
      if (field.max !== undefined) inp.max = String(field.max);
      if (field.step !== undefined) inp.step = String(field.step);
      inp.placeholder = formatSceneValue(field, field.def);
    }
    inp.value = present ? formatSceneValue(field, value) : "";
    // change 才提交：一次编辑进一次撤销栈，拖动 / 输入中间态不反复重挂
    inp.addEventListener("change", () => {
      const art = inp.value.trim();
      if (art === "") {
        opts.bad?.(et("log.sceneBad", { name: et(`scn.f.${field.key}`) }));
        inp.value = present ? formatSceneValue(field, value) : "";
        return;
      }
      const parsed = parseSceneValue(field, inp.value);
      if (parsed === null) {
        opts.bad?.(et("log.sceneBad", { name: et(`scn.f.${field.key}`) }));
        inp.value = present ? formatSceneValue(field, value) : "";
        return;
      }
      commit(field, parsed, () => (inp.value = present ? formatSceneValue(field, value) : ""));
    });
    ctl.append(inp, badge(row));
    return line;
  };

  function refresh() {
    root.textContent = "";
    const scene = opts.scene();
    const rows = scene ? sceneRows(scene) : null;
    for (const id of SCENE_GROUPS) {
      const fields = SCENE_FIELDS.filter((f) => f.group === id);
      if (!fields.length) continue;
      const title = document.createElement("div");
      title.className = "ed-menu-title";
      title.dataset.et = `scn.sec.${id}`;
      title.textContent = et(`scn.sec.${id}`);
      root.appendChild(title);
      for (const row of rows ?? []) if (row.field.group === id) root.appendChild(fieldRow(row));
    }
    if (!rows) {
      const none = document.createElement("p");
      none.className = "wb-hint";
      none.dataset.et = "scn.noDoc";
      none.textContent = et("scn.noDoc");
      root.appendChild(none);
    }
    for (const inp of root.querySelectorAll<HTMLInputElement>("input")) inp.disabled = !scene;
  }

  refresh();
  return { refresh };
}

export { mountSceneSettings };
