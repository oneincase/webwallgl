/**
 * 壁纸库条目分类（host 与 perf-bench 共用一份判据）。
 *
 * 为什么单独成文件：这份规则此前在 `host/wallpaper-host.ts::scanLibrary` 与
 * `scripts/perf-bench.mjs::scanLibrary` 各写了一遍，而两份都比**原生侧**
 * （`WallpaperEM/src-tauri/src/library.rs`）弱 —— 结果是测试台的「场景」标签
 * 少列条目：843532366 是 WE 的 GIF 导入模板场景（包名 `gifscene.pkg`，与
 * `scene.pkg` 同级），渲染器能挂（`renderer/src/api/source.ts` 的 PKG_PATHS 三布局、
 * `scene-mount` 读 gifscene.json），原生库也把它算 scene（app.db 实测 321 张），
 * 只有测试台既不认它、也没法归到别的标签 → **整个条目在列表里消失**。
 *
 * 规则逐条对齐原生：
 *   - `parse_project` 拿 project.json 的 `type`，经 `infer_type_from_tags` 白名单
 *     规范（Scene/scene 都收，未知值算 unknown）；
 *   - unknown（无 project.json / 没有 type / 值不在白名单）才按**内容**推断
 *     （`infer_type`）：index.html → web，场景包 → scene，否则按
 *     video > gif > image 取最优扩展名，`preview.*` 是封面不参与，最后兜底 image。
 *
 * 本文件是**纯函数**：不做 IO，目录内容由调用方按各自的 IO 风格（host 异步 /
 * perf-bench 同步）探好传进来，规则只有这一份。
 */

/**
 * 场景包的真实布局。与 `renderer/src/api/source.ts` 的 `PKG_PATHS`、
 * 原生 `library.rs::infer_type` 同一张表（`gifscene.pkg` = GIF 导入模板，843532366）。
 */
export const SCENE_PKG_PATHS = ["scene.pkg", "scenes/scene.pkg", "gifscene.pkg", "scenes/gifscene.pkg"];

/** 目录根下的网页入口（原生 `infer_type` 也只认这两个位置） */
export const WEB_ENTRY_PATHS = ["index.html", "web/index.html"];

/**
 * 松散工程（源码目录）形态的场景入口候选。
 *
 * 形态判定的**真源在渲染器侧**（`renderer/src/api/source.ts::sceneFormOf`）：只看
 * `project.json` 的 `file` 后缀 —— `.json` = 松散、`.pkg` = 包。这里只服务扫库/测试台
 * 的**标签归属**，所以宁松勿漏（判不到档的条目会在列表里整条消失，见文件头注），
 * 并额外容忍「没声明 file、但根上就摆着 scene.json」的工程形态。
 *
 * 已知盲区（本机 0 例）：入口 json 在子目录（如 `scenes/scene.json`）且 project.json
 * 没声明 file 时这里认不出；渲染器侧不受影响（它按 file 后缀判定）。
 */
export const LOOSE_SCENE_ENTRIES = ["scene.json", "gifscene.json"];

/**
 * 松散工程形态判定（扫库侧，纯函数）。
 * @param {{ declared?: unknown, names?: Iterable<string> }} facts
 * @returns {boolean}
 */
export function isLooseSceneProject(facts = {}) {
  const lower = new Set([...((facts.names ?? []))].map((n) => String(n).toLowerCase()));
  const decl = typeof facts.declared === "string" ? facts.declared.trim().replace(/^\/+/, "") : "";
  if (decl && /\.json$/i.test(decl) && !/^preview\./i.test(decl) && lower.has(decl.toLowerCase())) return true;
  return LOOSE_SCENE_ENTRIES.some((n) => lower.has(n));
}

/** 扩展名分组，逐字抄自原生 `library.rs` 的 VIDEO_EXTS / GIF_EXTS / IMAGE_EXTS / WEB_EXTS */
export const EXT_GROUPS = {
  video: ["mp4", "webm", "mov", "mkv", "m4v", "avi"],
  gif: ["gif"],
  image: ["png", "jpg", "jpeg", "webp", "bmp", "avif"],
  web: ["html", "htm"],
};

/** 类型优先级（数字小的赢），与原生 `infer_type` 的 rank 同序 */
const EXT_RANK = { video: 0, gif: 1, image: 2, web: 3 };

/**
 * 封面文件名的候选与优先级，抄自原生 `library.rs::PREVIEW_EXTS`
 * （导入视频时抽帧落 `preview.png`，图片/gif 导入则按原扩展名拷一份）。
 */
export const PREVIEW_EXTS = ["gif", "png", "jpg", "webp"];

/** 原生 `infer_type_from_tags` 认的类型名；其余（含 "application" 之外的怪值）一律算 unknown */
const DECLARED_TYPES = new Set(["video", "scene", "web", "gif", "application"]);

/**
 * project.json 的 `type` → 白名单类型；不在白名单返回 null（= 要按内容推断）。
 * 大小写不敏感：库里 `scene` 248 张、`Scene` 73 张混用，原生也是小写化后比对。
 * @param {unknown} declared
 * @returns {string | null}
 */
export function normalizeDeclaredType(declared) {
  if (typeof declared !== "string") return null;
  const t = declared.trim().toLowerCase();
  return DECLARED_TYPES.has(t) ? t : null;
}

/**
 * 判一个壁纸目录的**内容形态**（不含 project.json 的 type）。
 * @param {{ hasScene?: boolean, hasLooseScene?: boolean, hasWebEntry?: boolean, names?: Iterable<string> }} contents
 * @returns {"scene" | "web" | "gif" | "image" | "video" | null} 推断不出返回 null
 */
export function inferTypeFromContents({ hasScene = false, hasLooseScene = false, hasWebEntry = false, names = [] } = {}) {
  // 原生顺序：先 index.html 再场景包。两者同时存在的目录在本机库为 0 张，
  // 但顺序必须与原生一致，否则同库两边的标签会对不上。
  if (hasWebEntry) return "web";
  // 包形态与松散工程同属场景：松散目录没有 scene.pkg（WE 编辑器工程就是散装目录），
  // 只有 hasScene 这一条会让 17 个内置工程在测试台落到 image/video 标签甚至整条消失。
  if (hasScene || hasLooseScene) return "scene";
  let best = null;
  for (const raw of names) {
    const name = String(raw).toLowerCase();
    // preview.* 是封面不是内容：带 preview.gif 的视频目录不然会被判成 gif
    if (name.startsWith("preview.")) continue;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) continue;
    const ext = name.slice(dot + 1);
    for (const [type, exts] of Object.entries(EXT_GROUPS)) {
      if (exts.includes(ext) && (best === null || EXT_RANK[type] < EXT_RANK[best])) best = type;
    }
  }
  return best;
}

/**
 * 一个库条目的最终类型。
 * @param {{ declared?: unknown, hasScene?: boolean, hasLooseScene?: boolean, hasWebEntry?: boolean, names?: Iterable<string> }} facts
 * @returns {string} scene | web | video | gif | image | application
 */
export function classifyWallpaper(facts = {}) {
  const declared = normalizeDeclaredType(facts.declared);
  if (declared) return declared;
  return inferTypeFromContents(facts) ?? "image";
}

/**
 * 条目**入口文件**（相对壁纸目录的路径）—— 渲染器 query 的 `src` 尾巴。
 *
 * project.json 声明了 `file` 就用它；没声明的（单文件导入的壁纸没有 project.json，
 * 如 4_15488492008902 只有一支 mp4）按原生 `first_video_file` 的口径兜底：目录里
 * **按文件名排序**的第一个视频/图片（`preview.*` 是封面，排除）。排序不能省：
 * read_dir / readdir 的枚举顺序由文件系统决定，同一台机器跨次都可能不同，
 * 不排序会让「点哪个条目挂哪个文件」变得不可复现。
 * web 类型用实际存在的那个入口（根 index.html 优先，其次 web/index.html）。
 *
 * @param {{ declared?: unknown, type?: string, names?: Iterable<string>, webEntry?: string | null }} facts
 * @returns {string | undefined}
 */
export function pickEntryFile(facts = {}) {
  if (typeof facts.declared === "string" && facts.declared) return facts.declared;
  const names = [...(facts.names ?? [])]
    .map((n) => String(n))
    .filter((n) => !n.toLowerCase().startsWith("preview."))
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0));
  const extOf = (n) => {
    const dot = n.lastIndexOf(".");
    return dot > 0 ? n.slice(dot + 1).toLowerCase() : "";
  };
  if (facts.type === "web") return facts.webEntry || "index.html";
  const groups = facts.type === "video" ? [EXT_GROUPS.video] : facts.type === "gif" ? [EXT_GROUPS.gif] : facts.type === "image" ? [EXT_GROUPS.image] : [EXT_GROUPS.video, EXT_GROUPS.gif, EXT_GROUPS.image];
  for (const group of groups) {
    const hit = names.find((n) => group.includes(extOf(n)));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * 目录里的封面文件（相对路径），按原生 `PREVIEW_EXTS` 优先级取第一个存在的。
 * 只给「project.json 没声明 preview 或声明的那张不在盘上」的条目用 ——
 * 声明优先，避免给已有封面的条目换图（旧行为不变）。
 * @param {Iterable<string>} names
 * @returns {string | undefined} 如 "preview.png"
 */
export function pickPreviewFile(names = []) {
  const lower = new Map([...names].map((n) => [String(n).toLowerCase(), String(n)]));
  for (const ext of PREVIEW_EXTS) {
    const hit = lower.get(`preview.${ext}`);
    if (hit) return hit;
  }
  return undefined;
}
