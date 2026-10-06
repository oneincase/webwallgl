/**
 * 检视器「壁纸配置」：对标主项目的 WallpaperPropsModal —— 按类型渲染控件、按 condition
 * 对当前草稿求值显隐、改动即防抖保存并热更新。属性定义 / 覆盖值由宿主的 /api/props
 * 提供（复刻 we_props.rs）。只在标签可见时拉取，切走时不浪费请求。
 */

import { $, on, state } from "./store";
import { t } from "./i18n";
import { MEDIA_BASE, wp } from "./bridge";
import { log } from "./console";
import { tabs } from "./layout";
import { evalCondition, type ConditionValues } from "./we-condition";

/** 与 host/we-props.ts 的 WebPropDef 对齐（同主项目 library_item_props 的返回） */
type WebPropDef = {
  name: string;
  ptype: string;
  text: string;
  order: number;
  value: unknown;
  default: unknown;
  overridden: boolean;
  condition?: string;
  options?: { label: string; value: unknown; condition?: string }[];
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  /** file 属性的期望文件类别（image/video/audio），决定选择器过滤器 */
  fileType?: string;
  media?: { src: string; href?: string; width?: string; height?: string }[];
};

const propsBodyEl = $<HTMLDivElement>("#props-body");
const propsStateEl = $<HTMLSpanElement>("#props-state");
const propsFilterEl = $<HTMLInputElement>("#props-filter");
const propsAllEl = $<HTMLInputElement>("#props-all");
const propsResetEl = $<HTMLButtonElement>("#props-reset");

/** WE 线格式 "r g b"（0..1 浮点）→ #rrggbb */
function rgbStrToHex(s: string): string {
  const parts = String(s).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "#000000";
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(parts[0])}${h(parts[1])}${h(parts[2])}`;
}

/** #rrggbb → WE 线格式 "r g b"（6 位小数，与 project.json 精度一致） */
function hexToRgbStr(hex: string): string {
  let m = hex.replace("#", "");
  if (m.length === 3) m = m.split("").map((c) => c + c).join("");
  const n = Number.parseInt(m, 16);
  if (Number.isNaN(n)) return "0 0 0";
  const f = (v: number) => Number(v.toFixed(6));
  return `${f(((n >> 16) & 255) / 255)} ${f(((n >> 8) & 255) / 255)} ${f((n & 255) / 255)}`;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const SAVE_DEBOUNCE_MS = 400;

let propDefs: WebPropDef[] = [];
/** 分组折叠状态（按属性名）；缺省展开，避免「分组无法设置」 */
const propGroupOpen: Record<string, boolean> = {};
let propDraft: Record<string, unknown> = {};
let propItemId = "";
let saveTimer: number | undefined;

function propsState(msg: string, isErr = false) {
  propsStateEl.textContent = msg;
  propsStateEl.classList.toggle("is-err", isErr);
}

function showHint(text: string) {
  propsBodyEl.textContent = "";
  const hint = document.createElement("div");
  hint.className = "prop-hint wb-empty";
  hint.textContent = text;
  propsBodyEl.appendChild(hint);
}

async function loadProps(itemId: string) {
  propItemId = itemId;
  propDefs = [];
  propDraft = {};
  for (const k of Object.keys(propGroupOpen)) delete propGroupOpen[k];
  propsBodyEl.textContent = "";
  propsResetEl.disabled = true;
  propsState(t("props.reading"));
  try {
    const res = await fetch(`/api/props?item=${encodeURIComponent(itemId)}`);
    const data = (await res.json()) as { props?: WebPropDef[]; error?: string };
    if (data.error) throw new Error(data.error);
    if (propItemId !== itemId) return; // 期间切换了壁纸：丢弃这次结果
    propDefs = data.props ?? [];
    propDraft = Object.fromEntries(propDefs.filter((p) => p.value !== null).map((p) => [p.name, p.value]));
    const overridden = propDefs.filter((p) => p.overridden).length;
    propsState(
      propDefs.length === 0
        ? t("props.none")
        : overridden
          ? t("props.countOverridden", { n: propDefs.length, m: overridden })
          : t("props.count", { n: propDefs.length }),
    );
    propsResetEl.disabled = propDefs.length === 0;
    renderProps();
  } catch (e) {
    propsState(t("props.readFail", { msg: (e as Error).message }), true);
  }
}

/** 提交与默认值不同的属性（覆盖集）；空对象 = 清除全部覆盖 */
async function saveProps() {
  const overrides: Record<string, unknown> = {};
  // 遍历全部定义而非可见项：被条件隐藏的属性已有的覆盖值不能因隐藏而丢失
  for (const p of propDefs) {
    if (p.value === null) continue;
    if (!sameValue(propDraft[p.name], p.default)) overrides[p.name] = propDraft[p.name];
  }
  propsState(t("props.saving"));
  try {
    const res = await fetch(`/api/props?item=${encodeURIComponent(propItemId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(overrides),
    });
    const data = (await res.json()) as { error?: string };
    if (data.error) throw new Error(data.error);
    const n = Object.keys(overrides).length;
    propsState(n ? t("props.savedOverridden", { n }) : t("props.savedAll"));
    const wire: Record<string, { value: unknown }> = {};
    for (const [k, v] of Object.entries(propDraft)) wire[k] = { value: v };
    wp()?.updateWebProps(wire);
    log(t("props.logSaved", { id: propItemId, n }));
  } catch (e) {
    propsState(t("props.saveFail", { msg: (e as Error).message }), true);
  }
}

function scheduleSave() {
  propsState(t("props.pending"));
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void saveProps();
  }, SAVE_DEBOUNCE_MS);
}

function changeProp(name: string, value: unknown) {
  propDraft[name] = value;
  renderProps(); // condition 按当前草稿求值，改一项可能连带显隐其他项
  scheduleSave();
}

async function flushSave() {
  if (!saveTimer) return;
  window.clearTimeout(saveTimer);
  saveTimer = undefined;
  await saveProps();
}

function fileAccept(fileType?: string): string {
  switch (fileType) {
    case "video":
      return "video/*,.mp4,.webm,.mov,.m4v";
    case "audio":
      return "audio/*,.mp3,.ogg,.wav,.flac,.m4a";
    default:
      return "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp";
  }
}

function renderFileCtl(p: WebPropDef): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "prop-file";
  const path = String(propDraft[p.name] ?? "");
  const shown = document.createElement("span");
  shown.className = "prop-file-path";
  shown.textContent = path || t("props.fileUnset");
  if (path) shown.title = path;
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "prop-pick wb-btn is-filled";
  const isDir = p.ptype === "directory";
  pick.textContent = t(isDir ? "props.pickDir" : "props.pickFile");
  if (isDir) {
    pick.onclick = () => void pickPropDir(p.name, pick);
  } else {
    const file = document.createElement("input");
    file.type = "file";
    file.className = "prop-file-input";
    file.accept = fileAccept(p.fileType);
    file.onchange = () => {
      const f = file.files?.[0];
      file.value = "";
      if (f) void uploadPropFile(p.name, f, pick);
    };
    pick.onclick = () => file.click();
    wrap.appendChild(file);
  }
  wrap.append(shown, pick);
  return wrap;
}

async function uploadPropFile(name: string, file: File, btn: HTMLButtonElement) {
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = t("props.fileUploading");
  try {
    await flushSave();
    const res = await fetch(
      `/api/props-file?item=${encodeURIComponent(propItemId)}&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: { "X-Filename": encodeURIComponent(file.name) },
        body: file,
      },
    );
    const data = (await res.json()) as { value?: string; error?: string };
    if (!res.ok || data.error || !data.value) throw new Error(data.error || `HTTP ${res.status}`);
    changeProp(name, data.value);
  } catch (e) {
    log(t("err.pickFile", { msg: (e as Error).message }), "error");
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function pickPropDir(name: string, btn: HTMLButtonElement) {
  btn.disabled = true;
  try {
    await flushSave();
    const res = await fetch("/api/props-dir", { method: "POST" });
    const data = (await res.json()) as {
      value?: string;
      cancelled?: boolean;
      unsupported?: boolean;
      error?: string;
    };
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.cancelled) {
      if (!data.unsupported) return;
      const typed = window.prompt(t("props.dirPh"), String(propDraft[name] ?? ""));
      if (!typed) return;
      changeProp(name, typed.trim());
      return;
    }
    if (data.value) changeProp(name, data.value);
  } catch (e) {
    log(t("err.pickDir", { msg: (e as Error).message }), "error");
  } finally {
    btn.disabled = false;
  }
}

function mediaSrc(src: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (!propItemId) return src;
  return `${MEDIA_BASE}/${encodeURIComponent(propItemId)}/${src.replace(/^\.\//, "")}`;
}

function cssLen(v: string): string | undefined {
  const s = v.trim().replace(/^['"]+|['"]+$/g, "");
  if (!s) return undefined;
  if (/%|px|em|rem|vh|vw$/i.test(s)) return s;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? `${n}px` : undefined;
}

/** 作者 HTML 常写 height=30 当图标、width=2000 当横幅；横幅按比例缩，图标才钉高度。 */
function applyMediaSize(img: HTMLImageElement, m: { width?: string; height?: string }) {
  img.style.maxWidth = "100%";
  const w = m.width ? cssLen(m.width) : undefined;
  const h = m.height ? cssLen(m.height) : undefined;
  const hPx = h && h.endsWith("px") ? Number.parseFloat(h) : NaN;
  if (w && w.endsWith("%")) {
    img.style.width = w;
    img.style.height = "auto";
    return;
  }
  if (Number.isFinite(hPx) && hPx >= 16 && hPx <= 96) {
    img.style.height = h!;
    img.style.width = "auto";
    return;
  }
  img.style.height = "auto";
}

function renderMedia(media: { src: string; href?: string; width?: string; height?: string }[]): HTMLElement {
  const box = document.createElement("div");
  box.className = "prop-media";
  for (const m of media) {
    const img = document.createElement("img");
    img.src = mediaSrc(m.src);
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.loading = "lazy";
    applyMediaSize(img, m);
    if (m.href) {
      const a = document.createElement("a");
      a.href = m.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.appendChild(img);
      box.appendChild(a);
    } else {
      box.appendChild(img);
    }
  }
  return box;
}

/**
 * 作者常把整段 <img> HTML 写进属性 key，WE 剥掉符号后变成 imgsrchttp… 这种「名字」。
 * 有抽出的图时不要回退显示这段残渣。
 */
function looksLikeHtmlResidue(s: string): boolean {
  if (s.length < 24 || /\s/.test(s)) return false;
  return /^(imgsrc|ahref|hrbig|brahref)/i.test(s) || /viewer_4|photostore|qpiccn/i.test(s);
}

function propLabel(p: WebPropDef): string {
  if (p.text && !looksLikeHtmlResidue(p.text)) return p.text;
  if (p.media && p.media.length) return "";
  if (looksLikeHtmlResidue(p.name)) return "";
  return p.text || p.name;
}

function renderProps() {
  const kw = propsFilterEl.value.trim().toLowerCase();
  const showHidden = propsAllEl.checked;
  // condition 求值用的值表：与主项目一致，取当前草稿（拖动开关即时联动）
  const vals: ConditionValues = propDraft as ConditionValues;
  propsBodyEl.textContent = "";
  if (propDefs.length === 0) {
    showHint(t("props.empty"));
    return;
  }

  // 按 WE 语义把 type=group 当可折叠分节：其后属性归属该组，直到下一个 group。
  type Section = { group: WebPropDef | null; items: WebPropDef[] };
  const sections: Section[] = [];
  let cur: Section = { group: null, items: [] };
  sections.push(cur);
  for (const p of propDefs) {
    if (p.ptype === "group") {
      cur = { group: p, items: [] };
      sections.push(cur);
      continue;
    }
    cur.items.push(p);
  }

  let shown = 0;
  const appendItem = (p: WebPropDef, parent: HTMLElement) => {
    const visible = evalCondition(p.condition, vals);
    if (!visible && !showHidden) return;
    if (kw && !`${p.name} ${p.text}`.toLowerCase().includes(kw)) return;
    if (p.ptype === "text" && !propLabel(p) && !(p.media && p.media.length)) return;
    shown++;
    if (p.ptype === "text") {
      const te = document.createElement("div");
      te.className = "prop-text";
      if (p.media && p.media.length) te.appendChild(renderMedia(p.media));
      const capText = propLabel(p);
      if (capText) {
        const cap = document.createElement("div");
        cap.className = "prop-text-cap";
        cap.textContent = capText;
        te.appendChild(cap);
      }
      parent.appendChild(te);
      return;
    }
    parent.appendChild(renderPropRow(p, visible));
  };

  for (const sec of sections) {
    if (sec.group) {
      const visible = evalCondition(sec.group.condition, vals);
      if (!visible && !showHidden) continue;
      if (
        kw &&
        !`${sec.group.name} ${sec.group.text}`.toLowerCase().includes(kw) &&
        !sec.items.some((p) => `${p.name} ${p.text}`.toLowerCase().includes(kw))
      ) {
        continue;
      }
      shown++;
      const details = document.createElement("details");
      details.className = "prop-group wb-section";
      details.open = propGroupOpen[sec.group.name] ?? true;
      details.ontoggle = () => {
        propGroupOpen[sec.group!.name] = details.open;
      };
      const summary = document.createElement("summary");
      summary.className = "prop-group-summary";
      summary.textContent = propLabel(sec.group) || sec.group.name;
      summary.title = sec.group.name;
      details.appendChild(summary);
      const body = document.createElement("div");
      body.className = "prop-group-body";
      for (const p of sec.items) appendItem(p, body);
      details.appendChild(body);
      // 过滤后组内无可见项：仍显示组标题（作者分隔），避免整段消失像「坏了」
      propsBodyEl.appendChild(details);
      continue;
    }
    for (const p of sec.items) appendItem(p, propsBodyEl);
  }

  if (shown === 0) showHint(t(kw ? "props.noMatch" : "props.allHidden"));
}

function renderPropRow(p: WebPropDef, visible: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "prop";
  // 原始键名只放 title，主文案用 localization / 作者 text（避免面板上满屏 newproperty5）
  row.title = `${p.name} · ${p.ptype}`;
  if (!visible) row.classList.add("prop-cond"); // 条件隐藏但被强制显示：置灰提示
  const overridden = !sameValue(propDraft[p.name], p.default);
  if (overridden) row.classList.add("overridden");

  const head = document.createElement("div");
  head.className = "prop-head";
  const textWrap = document.createElement("div");
  textWrap.className = "prop-head-text";
  if (p.media && p.media.length) textWrap.appendChild(renderMedia(p.media));
  const label = propLabel(p);
  if (label) {
    const nameEl = document.createElement("span");
    nameEl.className = "prop-name";
    nameEl.textContent = label;
    textWrap.appendChild(nameEl);
  }
  head.appendChild(textWrap);

  if (p.ptype === "bool") {
    const sw = document.createElement("label");
    sw.className = "wb-switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "prop-bool";
    cb.checked = !!propDraft[p.name];
    cb.onchange = () => changeProp(p.name, cb.checked);
    sw.append(cb, document.createElement("i"));
    head.appendChild(sw);
  }
  if (overridden) {
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "prop-revert wb-icon-btn is-sm";
    revert.textContent = "↺";
    revert.title = t("props.revert");
    revert.onclick = () => changeProp(p.name, p.default);
    head.appendChild(revert);
  }
  row.appendChild(head);

  if (p.ptype === "bool") return row;

  const ctl = document.createElement("div");
  ctl.className = "prop-ctl";
  const cur = propDraft[p.name];
  switch (p.ptype) {
    case "color": {
      const col = document.createElement("input");
      col.type = "color";
      col.value = rgbStrToHex(String(cur ?? "0 0 0"));
      col.oninput = () => changeProp(p.name, hexToRgbStr(col.value));
      const txt = document.createElement("span");
      txt.className = "prop-key";
      txt.textContent = String(cur ?? "");
      ctl.append(col, txt);
      break;
    }
    case "slider": {
      // project.json 常不声明 min/max（WE 缺省 0..1）；precision 决定显示小数位与拖动粒度
      const min = p.min ?? 0;
      const max = p.max ?? 1;
      const prec = p.precision ?? (max - min <= 2 ? 3 : 0);
      const step = p.step ?? (prec > 0 ? 10 ** -prec : 1);
      const rng = document.createElement("input");
      rng.type = "range";
      rng.min = String(min);
      rng.max = String(max);
      rng.step = String(step);
      rng.value = String(Number(cur ?? min));
      const num = document.createElement("input");
      num.type = "text";
      num.className = "prop-num";
      num.value = Number(cur ?? min).toFixed(prec);
      rng.oninput = () => {
        num.value = Number(rng.value).toFixed(prec);
        changeProp(p.name, Number(rng.value));
      };
      num.onchange = () => {
        const n = Number(num.value);
        if (Number.isFinite(n)) changeProp(p.name, n);
      };
      ctl.append(rng, num);
      break;
    }
    case "combo": {
      const sel = document.createElement("select");
      for (const [i, o] of (p.options ?? []).entries()) {
        // 选项自身也可带 condition（少见但真实存在）
        if (!evalCondition(o.condition, propDraft as ConditionValues)) continue;
        const opt = document.createElement("option");
        opt.value = String(i); // 用下标做 value，避免把声明类型压成字符串
        opt.textContent = o.label;
        if (sameValue(o.value, cur)) opt.selected = true;
        sel.appendChild(opt);
      }
      sel.onchange = () => {
        const o = (p.options ?? [])[Number(sel.value)];
        if (o) changeProp(p.name, o.value);
      };
      ctl.appendChild(sel);
      break;
    }
    case "file":
    case "directory":
    case "scenetexture": {
      ctl.appendChild(renderFileCtl(p));
      break;
    }
    default: {
      const txt = document.createElement("input");
      txt.type = "text";
      txt.value = String(cur ?? "");
      txt.onchange = () => changeProp(p.name, txt.value);
      ctl.appendChild(txt);
    }
  }
  row.appendChild(ctl);
  return row;
}

propsFilterEl.oninput = renderProps;
propsAllEl.onchange = renderProps;
propsResetEl.onclick = () => {
  for (const p of propDefs) if (p.value !== null) propDraft[p.name] = p.default;
  renderProps();
  scheduleSave();
};

/** 跟随选中项：只有「壁纸配置」标签可见时才拉取，切过来时补拉 */
function sync() {
  const id = state.selected?.itemId ?? "";
  if (!id) {
    propItemId = "";
    propDefs = [];
    propsResetEl.disabled = true;
    propsState("");
    showHint(t("props.noSelection"));
    return;
  }
  if (tabs.right.current() === "props" && propItemId !== id) void loadProps(id);
}

/** 语言切换后重刷面板文案 */
export function refreshPropsPanel() {
  if (!state.selected) showHint(t("props.noSelection"));
  else if (propDefs.length) renderProps();
}

on("selection", sync);
on("tab", ({ panel }) => {
  if (panel === "right") sync();
});
sync();
