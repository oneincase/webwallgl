// 「壁纸配置」面板（右栏标签）：壁纸库条目的用户属性覆盖值 —— 对标 WE 属性窗口。
// 属性定义 / 覆盖值由宿主 /api/props 提供并落盘（只改覆盖表，不碰壁纸原文件）；
// 改动防抖保存，同时经 apply 热更到当前画面。condition 按当前草稿求值显隐。
// 这里改的是「这台机器上怎么播放这张壁纸」；工程自身的属性声明在检视器的工程页里编辑。

import { evalCondition, type ConditionValues } from "../../bench/we-condition";

/** 与 host/we-props.ts 的 WebPropDef 对齐 */
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
  fileType?: string;
  media?: { src: string; href?: string; width?: string; height?: string }[];
};

export type WallpaperConfigOptions = {
  body: HTMLElement;
  state: HTMLElement;
  filter: HTMLInputElement;
  showAll: HTMLInputElement;
  reset: HTMLButtonElement;
  mediaBase: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  log: (msg: string, level?: "info" | "warn" | "error") => void;
  /** 当前值表（全部属性）推给画面；返回 false 表示这类壁纸不能热更，保存后需重挂 */
  apply: (values: Record<string, unknown>) => boolean;
  /** 保存落盘后画面需要重挂时调用（网页 / 视频壁纸） */
  reload: () => void;
};

export type WallpaperConfig = {
  /** 切换到某个库条目（null = 当前文档不是库条目） */
  setItem(itemId: string | null): void;
  /** 当前与默认值不同的覆盖值（重挂时作为挂载初值） */
  overrides(): Record<string, unknown>;
  refresh(): void;
};

function rgbStrToHex(s: string): string {
  const parts = String(s).trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) return "#000000";
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(parts[0])}${h(parts[1])}${h(parts[2])}`;
}

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

/** 作者常把整段 <img> HTML 写进属性 key，WE 剥掉符号后变成 imgsrchttp… 这种「名字」 */
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

function cssLen(v: string): string | undefined {
  const s = v.trim().replace(/^['"]+|['"]+$/g, "");
  if (!s) return undefined;
  if (/%|px|em|rem|vh|vw$/i.test(s)) return s;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? `${n}px` : undefined;
}

/** 作者 HTML 常写 height=30 当图标、width=2000 当横幅；横幅按比例缩，图标才钉高度 */
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

function fileAccept(fileType?: string): string {
  if (fileType === "video") return "video/*,.mp4,.webm,.mov,.m4v";
  if (fileType === "audio") return "audio/*,.mp3,.ogg,.wav,.flac,.m4a";
  return "image/*,.png,.jpg,.jpeg,.webp,.gif,.bmp";
}

export function mountWallpaperConfig(o: WallpaperConfigOptions): WallpaperConfig {
  const { t } = o;
  let defs: WebPropDef[] = [];
  let draft: Record<string, unknown> = {};
  let itemId = "";
  let saveTimer: number | undefined;
  const groupOpen: Record<string, boolean> = {};

  const setState = (msg: string, isErr = false) => {
    o.state.textContent = msg;
    o.state.classList.toggle("is-err", isErr);
  };

  function hint(text: string) {
    o.body.textContent = "";
    const el = document.createElement("div");
    el.className = "prop-hint wb-empty";
    el.textContent = text;
    o.body.appendChild(el);
  }

  async function loadProps(id: string) {
    itemId = id;
    defs = [];
    draft = {};
    for (const k of Object.keys(groupOpen)) delete groupOpen[k];
    o.body.textContent = "";
    o.reset.disabled = true;
    setState(t("props.reading"));
    try {
      const res = await fetch(`/api/props?item=${encodeURIComponent(id)}`);
      const data = (await res.json()) as { props?: WebPropDef[]; error?: string };
      if (data.error) throw new Error(data.error);
      if (itemId !== id) return;
      defs = data.props ?? [];
      draft = Object.fromEntries(defs.filter((p) => p.value !== null).map((p) => [p.name, p.value]));
      const overridden = defs.filter((p) => p.overridden).length;
      setState(
        defs.length === 0 ? t("props.none") : overridden ? t("props.countOverridden", { n: defs.length, m: overridden }) : t("props.count", { n: defs.length }),
      );
      o.reset.disabled = defs.length === 0;
      render();
    } catch (e) {
      if (itemId === id) setState(t("props.readFail", { msg: (e as Error).message }), true);
    }
  }

  function overrides(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    // 遍历全部定义而非可见项：被条件隐藏的属性已有的覆盖值不能因隐藏而丢失
    for (const p of defs) {
      if (p.value === null) continue;
      if (!sameValue(draft[p.name], p.default)) out[p.name] = draft[p.name];
    }
    return out;
  }

  async function saveProps() {
    const id = itemId;
    const ov = overrides();
    setState(t("props.saving"));
    try {
      const res = await fetch(`/api/props?item=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ov),
      });
      const data = (await res.json()) as { error?: string };
      if (data.error) throw new Error(data.error);
      const n = Object.keys(ov).length;
      setState(n ? t("props.savedOverridden", { n }) : t("props.savedAll"));
      o.log(t("props.logSaved", { id, n }));
      if (!o.apply({ ...draft })) o.reload();
    } catch (e) {
      setState(t("props.saveFail", { msg: (e as Error).message }), true);
    }
  }

  function scheduleSave() {
    setState(t("props.pending"));
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = undefined;
      void saveProps();
    }, SAVE_DEBOUNCE_MS);
  }

  function change(name: string, value: unknown) {
    draft[name] = value;
    o.apply({ [name]: value });
    render();
    scheduleSave();
  }

  async function flushSave() {
    if (!saveTimer) return;
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    await saveProps();
  }

  const mediaSrc = (src: string) =>
    /^https?:\/\//i.test(src) || !itemId ? src : `${o.mediaBase}/${encodeURIComponent(itemId)}/${src.replace(/^\.\//, "")}`;

  function renderMedia(media: NonNullable<WebPropDef["media"]>): HTMLElement {
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

  async function uploadFile(name: string, file: File, btn: HTMLButtonElement) {
    btn.disabled = true;
    const prev = btn.textContent;
    btn.textContent = t("props.fileUploading");
    try {
      await flushSave();
      const res = await fetch(`/api/props-file?item=${encodeURIComponent(itemId)}&name=${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "X-Filename": encodeURIComponent(file.name) },
        body: file,
      });
      const data = (await res.json()) as { value?: string; error?: string };
      if (!res.ok || data.error || !data.value) throw new Error(data.error || `HTTP ${res.status}`);
      change(name, data.value);
    } catch (e) {
      o.log(t("err.pickFile", { msg: (e as Error).message }), "error");
      btn.disabled = false;
      btn.textContent = prev;
    }
  }

  async function pickDir(name: string, btn: HTMLButtonElement) {
    btn.disabled = true;
    try {
      await flushSave();
      const res = await fetch("/api/props-dir", { method: "POST" });
      const data = (await res.json()) as { value?: string; cancelled?: boolean; unsupported?: boolean; error?: string };
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.cancelled) {
        if (!data.unsupported) return;
        const typed = window.prompt(t("props.dirPh"), String(draft[name] ?? ""));
        if (typed) change(name, typed.trim());
        return;
      }
      if (data.value) change(name, data.value);
    } catch (e) {
      o.log(t("err.pickDir", { msg: (e as Error).message }), "error");
    } finally {
      btn.disabled = false;
    }
  }

  function fileCtl(p: WebPropDef): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "prop-file";
    const path = String(draft[p.name] ?? "");
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
      pick.onclick = () => void pickDir(p.name, pick);
    } else {
      const file = document.createElement("input");
      file.type = "file";
      file.className = "prop-file-input";
      file.accept = fileAccept(p.fileType);
      file.onchange = () => {
        const f = file.files?.[0];
        file.value = "";
        if (f) void uploadFile(p.name, f, pick);
      };
      pick.onclick = () => file.click();
      wrap.appendChild(file);
    }
    wrap.append(shown, pick);
    return wrap;
  }

  function row(p: WebPropDef, visible: boolean): HTMLElement {
    const el = document.createElement("div");
    el.className = "prop";
    el.dataset.prop = p.name;
    el.title = `${p.name} · ${p.ptype}`;
    if (!visible) el.classList.add("prop-cond");
    const overridden = !sameValue(draft[p.name], p.default);
    if (overridden) el.classList.add("overridden");

    const head = document.createElement("div");
    head.className = "prop-head";
    const textWrap = document.createElement("div");
    textWrap.className = "prop-head-text";
    if (p.media && p.media.length) textWrap.appendChild(renderMedia(p.media));
    const label = propLabel(p);
    if (label) {
      const name = document.createElement("span");
      name.className = "prop-name";
      name.textContent = label;
      textWrap.appendChild(name);
    }
    head.appendChild(textWrap);
    if (p.ptype === "bool") {
      const sw = document.createElement("label");
      sw.className = "wb-switch";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "prop-bool";
      cb.checked = !!draft[p.name];
      cb.onchange = () => change(p.name, cb.checked);
      sw.append(cb, document.createElement("i"));
      head.appendChild(sw);
    }
    if (overridden) {
      const revert = document.createElement("button");
      revert.type = "button";
      revert.className = "prop-revert wb-icon-btn is-sm";
      revert.textContent = "↺";
      revert.title = t("props.revert");
      revert.onclick = () => change(p.name, p.default);
      head.appendChild(revert);
    }
    el.appendChild(head);
    if (p.ptype === "bool") return el;

    const ctl = document.createElement("div");
    ctl.className = "prop-ctl";
    const cur = draft[p.name];
    switch (p.ptype) {
      case "color": {
        const col = document.createElement("input");
        col.type = "color";
        col.value = rgbStrToHex(String(cur ?? "0 0 0"));
        col.oninput = () => change(p.name, hexToRgbStr(col.value));
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
          draft[p.name] = Number(rng.value);
          o.apply({ [p.name]: draft[p.name] });
          scheduleSave();
        };
        rng.onchange = () => render();
        num.onchange = () => {
          const n = Number(num.value);
          if (Number.isFinite(n)) change(p.name, n);
        };
        ctl.append(rng, num);
        break;
      }
      case "combo": {
        const sel = document.createElement("select");
        for (const [i, opt] of (p.options ?? []).entries()) {
          if (!evalCondition(opt.condition, draft as ConditionValues)) continue;
          const el2 = document.createElement("option");
          el2.value = String(i);
          el2.textContent = opt.label;
          if (sameValue(opt.value, cur)) el2.selected = true;
          sel.appendChild(el2);
        }
        sel.onchange = () => {
          const opt = (p.options ?? [])[Number(sel.value)];
          if (opt) change(p.name, opt.value);
        };
        ctl.appendChild(sel);
        break;
      }
      case "file":
      case "directory":
      case "scenetexture":
        ctl.appendChild(fileCtl(p));
        break;
      default: {
        const txt = document.createElement("input");
        txt.type = "text";
        txt.value = String(cur ?? "");
        txt.onchange = () => change(p.name, txt.value);
        ctl.appendChild(txt);
      }
    }
    el.appendChild(ctl);
    return el;
  }

  function render() {
    if (!itemId) {
      hint(t("props.noLibraryItem"));
      return;
    }
    const kw = o.filter.value.trim().toLowerCase();
    const showHidden = o.showAll.checked;
    const vals = draft as ConditionValues;
    o.body.textContent = "";
    if (defs.length === 0) {
      hint(t("props.empty"));
      return;
    }
    type Section = { group: WebPropDef | null; items: WebPropDef[] };
    const sections: Section[] = [{ group: null, items: [] }];
    for (const p of defs) {
      if (p.ptype === "group") sections.push({ group: p, items: [] });
      else sections[sections.length - 1].items.push(p);
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
        const cap = propLabel(p);
        if (cap) {
          const c = document.createElement("div");
          c.className = "prop-text-cap";
          c.textContent = cap;
          te.appendChild(c);
        }
        parent.appendChild(te);
        return;
      }
      parent.appendChild(row(p, visible));
    };
    for (const sec of sections) {
      if (!sec.group) {
        for (const p of sec.items) appendItem(p, o.body);
        continue;
      }
      const g = sec.group;
      if (!evalCondition(g.condition, vals) && !showHidden) continue;
      if (kw && !`${g.name} ${g.text}`.toLowerCase().includes(kw) && !sec.items.some((p) => `${p.name} ${p.text}`.toLowerCase().includes(kw))) continue;
      shown++;
      const details = document.createElement("details");
      details.className = "prop-group wb-section";
      details.open = groupOpen[g.name] ?? true;
      details.ontoggle = () => (groupOpen[g.name] = details.open);
      const summary = document.createElement("summary");
      summary.className = "prop-group-summary";
      summary.textContent = propLabel(g) || g.name;
      summary.title = g.name;
      const body = document.createElement("div");
      body.className = "prop-group-body";
      for (const p of sec.items) appendItem(p, body);
      details.append(summary, body);
      o.body.appendChild(details);
    }
    if (shown === 0) hint(t(kw ? "props.noMatch" : "props.allHidden"));
  }

  o.filter.oninput = render;
  o.showAll.onchange = render;
  o.reset.onclick = () => {
    for (const p of defs) if (p.value !== null) draft[p.name] = p.default;
    o.apply({ ...draft });
    render();
    scheduleSave();
  };

  return {
    setItem(id) {
      if ((id ?? "") === itemId) return;
      void flushSave();
      if (!id) {
        itemId = "";
        defs = [];
        draft = {};
        o.reset.disabled = true;
        setState("");
        render();
        return;
      }
      void loadProps(id);
    },
    overrides,
    refresh: render,
  };
}
