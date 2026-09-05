/**
 * WE 壁纸自定义属性（project.json `general.properties`）解析 —— 主项目
 * `src-tauri/src/we_props.rs` 的 TypeScript 复刻，语义逐条对齐（含其按 1294 个
 * 真实属性校准出的 5 条反直觉结论，见该文件头注释）：
 *
 *  - `order` 按浮点读：真实壁纸用 32.5 / 1151.0022 做细分排序键，整数化会打乱同组顺序；
 *  - `combo` 选项值保留声明的 JSON 类型：整数/字符串/布尔混用是常态，统一字符串化会让
 *    壁纸里的 `===` / `switch` 全部失配；
 *  - 文案取壁纸自带 `general.localization`，按 zh-chs → zh-cht → en-us **逐键**回退
 *    （表是残缺的，逐语言回退会漏），并剥离 HTML、解码实体；
 *  - `text` 类型是静态说明/分节标题而非输入框（138 个 text 里 134 个连 value 都没有）；
 *  - `condition` 只用于 UI 显隐，`effectiveProps` 绝不据此过滤 —— WE 下被隐藏的属性
 *    照样要下发给壁纸，过滤会让壁纸读不到值而异常。
 *
 * 与主项目的差异：覆盖值存放在仓库根 `.we-props/{itemId}.json`（主项目存 sqlite
 * settings 表）。测试台是单机调试工具，用文件更便于直接查看/清空。
 */
import { promises as fs } from "node:fs";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 覆盖值存放目录（仓库根 .we-props/，已 gitignore） */
const OVERRIDES_DIR = resolve(here, "..", ".we-props");

/** UI 编辑用的属性定义（字段与主项目 `WebPropDef` 一致，camelCase 上报） */
export type WebPropDef = {
  name: string;
  /** color | bool | slider | combo | text | textinput | file | directory | group | other */
  ptype: string;
  /** 显示名（localization 表 → WE 内建映射 → 属性名；已剥离 HTML） */
  text: string;
  /** 排序键，浮点 */
  order: number;
  /** 当前生效值（覆盖或默认），wire 格式 */
  value: unknown;
  /** project.json 默认值，wire 格式；无默认值为 null */
  default: unknown;
  overridden: boolean;
  /** WE 显隐条件表达式，由前端按当前草稿求值（仅影响 UI） */
  condition?: string;
  /** combo 选项 */
  options?: ComboOption[];
  min?: number;
  max?: number;
  step?: number;
  /** slider 显示精度（小数位数） */
  precision?: number;
  /** file 属性的期望文件类别（image/video/audio），决定选择器过滤器 */
  fileType?: string;
  /** 文案 HTML 里抽出的图（WE 属性面板会渲染 <img>；只含 http(s) 或壁纸内相对路径） */
  media?: PropMedia[];
};

export type ComboOption = {
  label: string;
  /** 保留 project.json 声明的 JSON 类型 */
  value: unknown;
  condition?: string;
};

type Json = Record<string, any>;

/** 读取并解析壁纸目录下的 project.json；失败（无文件/非法 JSON）返回 null */
export function loadProject(itemDir: string): Json | null {
  try {
    const text = readFileSync(join(itemDir, "project.json"), "utf8");
    const v = JSON.parse(text.replace(/^\uFEFF/, ""));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** general.properties 原始条目（仅保留有 "type" 的真属性，跳过 tip/ui_* 纯显示项） */
function rawProps(project: Json): Array<[string, Json]> {
  const props = project?.general?.properties;
  if (!props || typeof props !== "object") return [];
  const out: Array<[string, Json]> = Object.entries(props).filter(
    ([, v]) => v && typeof v === "object" && typeof (v as Json).type === "string",
  ) as Array<[string, Json]>;
  // order 按浮点读；并列时按属性名兜底保证稳定序。
  // 名字比较必须按**码位**而非 localeCompare：后者对大小写做不敏感的排序整理，
  // 会与主项目 Rust 侧的字节序不一致（实测 rainbow_barWidth / rainbow_barsAmount、
  // SemiCircledirection / monstercat_reverse 两对同 order 属性因此换位）。
  out.sort((a, b) => orderOf(a[1]) - orderOf(b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** 属性排序键；缺失或非数值为 0 */
function orderOf(def: Json): number {
  const n = Number(def?.order);
  return Number.isFinite(n) ? n : 0;
}

/**
 * project.json 属性值 → WE 线格式；无值（如未选文件的 file）返回 undefined → 整个属性跳过。
 * color 为 "r g b" 空格分隔浮点串；bool 为布尔；slider 为数值；combo 保留声明类型；其余按字符串透传。
 */
function wireValue(ptype: string, def: Json): unknown | undefined {
  if (!("value" in def)) return undefined;
  const raw = def.value;
  if (raw === null || raw === undefined) return undefined;
  switch (ptype) {
    case "color":
      return typeof raw === "string" ? raw : undefined;
    case "bool":
      return typeof raw === "boolean" ? raw : undefined;
    case "slider": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "combo":
      return raw;
    default:
      return typeof raw === "string" ? raw : JSON.stringify(raw);
  }
}

function overridesFile(itemId: string): string {
  // itemId 来自 URL：只允许工坊 id 形态的字符，避免拼出目录穿越路径
  const safe = itemId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return join(OVERRIDES_DIR, `${safe}.json`);
}

/** 读取用户覆盖值（name → wire 值） */
export async function readOverrides(itemId: string): Promise<Record<string, unknown>> {
  try {
    const text = await fs.readFile(overridesFile(itemId), "utf8");
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** 保存用户覆盖值；空对象等价于清除（删文件） */
export async function writeOverrides(
  itemId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const file = overridesFile(itemId);
  if (!values || Object.keys(values).length === 0) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.mkdir(OVERRIDES_DIR, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(values, null, 2)}\n`, "utf8");
}

/**
 * 当前生效的完整属性表（默认值 + 用户覆盖），wire 格式 `{name: {value}}`。
 * 供网页壁纸 shim 引导使用（WE 契约：隐藏属性照样下发，故不按 condition 过滤）。
 */
export async function effectiveProps(
  wallpapersDir: string,
  itemId: string,
): Promise<Record<string, { value: unknown }>> {
  const itemDir = join(wallpapersDir, itemId);
  const project = loadProject(itemDir);
  if (!project) return {};
  const overrides = await readOverrides(itemId);
  const filePrefix = entryDirPrefix(itemDir, project);
  const out: Record<string, { value: unknown }> = {};
  for (const [name, def] of rawProps(project)) {
    const ptype = String(def.type ?? "");
    let v = name in overrides ? overrides[name] : wireValue(ptype, def);
    if (v === undefined) continue;
    // file 属性：值相对壁纸根存储，下发时按入口 HTML 所在目录补前缀（WE 语义：
    // 文件属性相对路径以入口页面为基准解析）。空值不补，否则凭空指向一个目录。
    if (ptype === "file" && typeof v === "string" && v !== "") v = `${filePrefix}${v}`;
    out[name] = { value: v };
  }
  return out;
}

/**
 * 仅用户覆盖值（wire 格式 `{name: {value}}`）。
 *
 * 场景壁纸渲染取这一份而非 effectiveProps：scene.json 里每个受属性控制的字段都自带
 * `{user, value}` 快照，本机 78 个场景共 2598 处引用中有 372 处的快照与 project.json
 * 默认值并不相等（作者改过属性默认值但没重存场景，或字段名与属性名撞车）。
 * 若无条件改用 project.json 默认值，这些图层的颜色/透明度/可见性会在**用户什么都没改**
 * 的情况下变样。故默认渲染沿用场景内快照，只有用户显式改过的属性才覆盖。
 */
export async function overrideProps(
  wallpapersDir: string,
  itemId: string,
): Promise<Record<string, { value: unknown }>> {
  const project = loadProject(join(wallpapersDir, itemId));
  if (!project) return {};
  const overrides = await readOverrides(itemId);
  if (Object.keys(overrides).length === 0) return {};
  const declared = new Map(rawProps(project));
  const out: Record<string, { value: unknown }> = {};
  for (const [name, v] of Object.entries(overrides)) {
    if (!declared.has(name)) continue; // 属性已从 project.json 移除：陈旧覆盖值忽略
    out[name] = { value: v };
  }
  return out;
}

/** 入口 HTML 所在子目录前缀（相对壁纸根），如 "web/"、"pages/"；根入口为 "" */
function entryDirPrefix(itemDir: string, project: Json | null): string {
  const f = project?.file;
  if (typeof f === "string") {
    const rel = f.trim().replace(/\\/g, "/");
    if (
      rel !== "" &&
      !rel.startsWith("/") &&
      !rel.split("/").includes("..") &&
      isFile(join(itemDir, rel))
    ) {
      return prefixOf(rel);
    }
  }
  if (isFile(join(itemDir, "web", "index.html"))) return "web/";
  if (isFile(join(itemDir, "index.html"))) return "";
  return "";
}

function isFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

function prefixOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i + 1);
}

/**
 * 文案解析优先语言，按序逐「键」回退。必须逐键而非逐语言：真实壁纸的 localization
 * 表是残缺的（同一壁纸 en-us 有 152 条、其他语言只有 5 条）。
 */
const TEXT_LANGS = ["zh-chs", "zh-cht", "en-us"];

/** WE 内建 i18n key → 中文显示名（由 WE 客户端字符串表提供，不在壁纸里，只能硬编码） */
const BUILTIN_TEXT: Record<string, string> = {
  ui_browse_properties_scheme_color: "主题颜色",
};

/** general.localization 查表：{lang: {key: text}}，语言标签大小写不敏感 */
function localized(project: Json, key: string): string | null {
  const table = project?.general?.localization;
  if (!table || typeof table !== "object") return null;
  for (const want of TEXT_LANGS) {
    for (const [lang, entries] of Object.entries(table)) {
      if (lang.toLowerCase() !== want) continue;
      const s = (entries as Json)?.[key];
      if (typeof s === "string" && s.trim() !== "") return s;
    }
  }
  return null;
}

/**
 * 剥离 HTML 标签、解码实体、折叠空白。
 * 壁纸文案里 `<br />`、`<h4 class='ugcSuccess'>`、整段打赏 `<a><img></a>` 都很常见。
 *
 * `keepBreaks`：属性显示名保留作者的 `<br>`（中英对照各占一行）。
 * combo 选项必须单行，调用处传 false，避免 `<option>` 里塞进换行。
 */
function stripHtml(raw: string, keepBreaks = false): string {
  const src = keepBreaks ? raw.replace(/<br\s*\/?>/gi, "\n") : raw;
  let text = "";
  let depth = 0;
  for (const ch of src) {
    if (ch === "<") depth++;
    else if (ch === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0) text += ch;
    // 标签边界补空格，避免 `a<br>b` 粘成 `ab`（br 已先换成换行，不会再走这里）
    if (ch === ">" && depth === 0) text += " ";
  }
  const decoded = decodeEntities(text);
  if (!keepBreaks) return decoded.split(/\s+/).filter(Boolean).join(" ");
  return decoded
    .split("\n")
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "))
    .join("\n")
    .replace(/^\n+|\n+$/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * 解码 HTML 实体：数值实体通用处理，命名实体取常见集。
 * 真实壁纸文案里出现过 `&ensp;`（320 处）与 `&#x2030;`（118 处）。
 */
function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const n = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(n) ? safeChar(n, whole) : whole;
    }
    if (body.startsWith("#")) {
      const n = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(n) ? safeChar(n, whole) : whole;
    }
    switch (body) {
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      // 各类空格实体统一压成普通空格（随后按空白折叠）
      case "nbsp":
      case "ensp":
      case "emsp":
      case "thinsp":
        return " ";
      case "amp":
        return "&";
      default:
        return whole; // 未识别的实体原样保留，不吞掉可能有意义的文本
    }
  });
}

function safeChar(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

/**
 * 属性/选项文案解析：localization 表 → WE 内建映射 → 原文 → 回退值。
 * 对任意 raw 都查表（不限 ui_ 前缀：真实壁纸有 `Dividing_line0` 这类无前缀键）。
 */
function resolveText(project: Json, raw: string, fallback: string, keepBreaks = false): string {
  const resolved = localized(project, raw) ?? BUILTIN_TEXT[raw] ?? raw;
  const clean = stripHtml(resolved, keepBreaks);
  // 清理后为空（纯 HTML 装饰/打赏横幅）或仍是未解析的 ui_ 键 → 回退
  if (clean === "" || clean.startsWith("ui_")) return fallback;
  return clean;
}

/** 属性面板用的图：src + 可选外链。不走 innerHTML，避免作者 HTML 注入。 */
export type PropMedia = { src: string; href?: string; width?: string; height?: string };

function attr(tag: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  const v = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
  return v === "" ? undefined : decodeEntities(v);
}

function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function isSafeHref(s: string): boolean {
  return isHttpUrl(s);
}

/** 壁纸内相对路径（无 ..、无协议）或 http(s)。javascript/data 一律丢掉。 */
function isSafeImgSrc(s: string): boolean {
  if (isHttpUrl(s)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  if (s.includes("..")) return false;
  return s.length > 0 && !s.startsWith("/");
}

function extractMedia(html: string): PropMedia[] {
  const out: PropMedia[] = [];
  let href: string | undefined;
  const re = /<a\b[^>]*>|<\/a>|<img\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const lower = tag.toLowerCase();
    if (lower.startsWith("<a")) {
      const h = attr(tag, "href");
      href = h && isSafeHref(h) ? h : undefined;
    } else if (lower.startsWith("</a")) {
      href = undefined;
    } else {
      const src = attr(tag, "src");
      if (src && isSafeImgSrc(src)) {
        const item: PropMedia = href ? { src, href } : { src };
        const w = attr(tag, "width")?.replace(/^['"]+|['"]+$/g, "");
        const h = attr(tag, "height")?.replace(/^['"]+|['"]+$/g, "");
        if (w) item.width = w;
        if (h) item.height = h;
        out.push(item);
      }
    }
  }
  return out;
}

/**
 * 属性显示名 + 文案里的图。纯图横幅（strip 后为空）不再回退成属性名，
 * 否则面板上只剩 logo1 / fengefu000，作者的分隔 GIF 全没了。
 */
function resolveDisplay(project: Json, raw: string, fallback: string): { text: string; media?: PropMedia[] } {
  const resolved = localized(project, raw) ?? BUILTIN_TEXT[raw] ?? raw;
  const media = extractMedia(resolved);
  const clean = stripHtml(resolved, true);
  const empty = clean === "" || clean.startsWith("ui_");
  const text = empty ? (media.length > 0 ? "" : fallback) : clean;
  return media.length > 0 ? { text, media } : { text };
}

/** 属性定义列表（UI 编辑用）；无 project.json / 无属性时为空 */
export async function describe(wallpapersDir: string, itemId: string): Promise<WebPropDef[]> {
  const project = loadProject(join(wallpapersDir, itemId));
  if (!project) return [];
  const overrides = await readOverrides(itemId);
  return rawProps(project).map(([name, def]) => {
    const ptype = String(def.type ?? "other");
    const dflt = wireValue(ptype, def);
    const value = name in overrides ? overrides[name] : dflt;
    const options: ComboOption[] = Array.isArray(def.options)
      ? def.options
          .filter((o: Json) => o && typeof o.label === "string" && "value" in o)
          .map((o: Json) => ({
            label: resolveText(
              project,
              o.label,
              // 选项标签回退用值本身（选项没有「名字」可回退）
              typeof o.value === "string" ? o.value : JSON.stringify(o.value),
            ),
            value: o.value,
            condition: strField(o, "condition"),
          }))
      : [];
    const display = resolveDisplay(project, typeof def.text === "string" ? def.text : "", name);
    const out: WebPropDef = {
      name,
      ptype,
      text: display.text,
      order: orderOf(def),
      value: value === undefined ? null : value,
      default: dflt === undefined ? null : dflt,
      overridden: name in overrides,
    };
    if (display.media) out.media = display.media;
    const cond = strField(def, "condition");
    if (cond) out.condition = cond;
    if (options.length) out.options = options;
    if (Number.isFinite(Number(def.min))) out.min = Number(def.min);
    if (Number.isFinite(Number(def.max))) out.max = Number(def.max);
    if (Number.isFinite(Number(def.step))) out.step = Number(def.step);
    if (Number.isFinite(Number(def.precision))) out.precision = Number(def.precision);
    const ft = strField(def, "fileType");
    if (ft) out.fileType = ft;
    return out;
  });
}

/** 读取非空字符串字段 */
function strField(v: Json, key: string): string | undefined {
  const s = v?.[key];
  if (typeof s !== "string") return undefined;
  const t = s.trim();
  return t === "" ? undefined : t;
}
