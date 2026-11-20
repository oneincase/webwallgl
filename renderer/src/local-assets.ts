/**
 * 本机引擎内置素材（WE 安装目录 `assets/` 树）接入。
 *
 * ## 为什么存在
 * 工坊壁纸的效果链 / 材质 / 粒子系统会按名字引用 WE 安装目录自带的公共贴图
 * （`util/white`、`util/flatnormal`、`particle/halo`、`particle/drop_normal` …），
 * 这些**不在壁纸 pkg 里**。仓库里没有官方字节（受版权保护，见 docs/COMPLIANCE.md），
 * 只用 system-textures.js / particle-textures.js / gradient-textures.js 的程序化
 * 复刻顶上 —— 观感近似但逐像素对不上（法线参考、噪声颗粒、粒子精灵形状差异最明显）。
 *
 * 本模块是**本地测试用的可选通路**：谁本机有原版素材（拷到 `local-assets/`，
 * 顶层平铺 = 官方 assets 树；旧布局 `local-assets/mirage/` 也认；或
 * `WE_LOCAL_ASSETS=/abs/path` 指向别处），dev server 的 `/api/local-assets`
 * 把它们喂过来，这里解码成 `{width,height,rgba}` 并经宿主 provider 注入引擎
 * → 渲染与官方对齐。没有素材时 `/api/local-assets` 返回 `{ok:false}`，本模块
 * 返回 null、引擎走程序化复刻，**行为与无素材时完全一致**。
 *
 * ## 消费面（官方 assets 树逐目录的取舍）
 *   - `materials/**`（.tex 贴图）：**唯一按名进运行时的目录** ——
 *     `util/*` 急切（效果链槽位默认值）、`particle/**` 按需（精灵图集很大）、
 *     `gradient/*` / `lut/*` / `pattern/*` / `cookie/*` 按需（loadTexInner 的
 *     pkg-miss 路径先问 ensureLocalAsset，命中官方像素；miss 则程序化复刻兜底）；
 *   - `fonts/**`：仅当壁纸文字层引用的字体 pkg 里没内嵌时作后备
 *     （fetchLocalAssetFile，scene-mount 字体装配调用），官方树里是
 *     NotoSans / RobotoMono / TwemojiMozilla 等可再分发字体；
 *   - `shaders/` 与 `materials/` 下的材质 JSON、`effects/`：**不进运行时** ——
 *     官方 shader 头带 saturate/lerp 定义，会被 hlsl2glsl 按名改写出语法错误
 *     （headers.ts 的重建子集就是为绕开这个），官方材质 / 效果 JSON 又与渲染器的
 *     原生效果实现（waterripple / pulse / blend …）语义重叠，混喂只会打架；
 *     这些目录留作「效果链重实现的对照参考」；
 *   - `presets/`、`scenes/`、`models/editor`、`scripts/`：编辑器侧资源，
 *     播放路径不引用。
 *
 * ## 装载策略（内存是有代价的：一张 512² RGBA 就是 1MB，全量 164 张粒子图解码后 ~180MB）
 *   - `util/**`（9 张，含 flatnormal 法线参考）：挂载时**急切**装载 —— 它们是
 *     「效果链槽位默认值」，注册循环是同步的，必须在注册前就绪；
 *   - `particle/**`（164 张精灵图集 + 法线）：**按需**装载 —— 由 scene-mount 的
 *     `loadParticleTex`（本来就是 async）在取贴图前 `await ensureLocalAsset(name)`，
 *     只把这一张场景真正用到的拉下来；
 *   - `?localAssets=all`：全量急切装载（批量对账 / 预热点用，接受内存占用）。
 *
 * ## 开关
 *   `?localAssets=0|off` 关闭；`all` 全量；`fonts` 只开字体通路；`1|on` 或 dev 缺省 =
 *   util 急切 + particle 按需。`?fonts=1` 等价 `?localAssets=fonts`。
 *   库宿主用 `MountOptions.localAssets` / `WallpaperConfig.localAssets` 显式指定档位，
 *   **显式值优先于 URL 参数**。只有 dev（`import.meta.env.DEV`）或显式配置/参数才发请求，
 *   生产构建缺省不会产生任何请求（issue #24：字体探测原来被贴图开关绑死 ——
 *   `off` 时连 `/api/local-assets` 都不探测，WE 内置字体只能静默回落 sans-serif）。
 */
import { tex, ptex, sysTex, gtex, patTex } from "./vendor";
import type { LocalAssetsMode } from "./types";

/** 一次装载的结果（给 diag / `window.__localAssets` 看） */
export type LocalAssetStats = {
  source: string;
  available: number;
  requested: number;
  loaded: number;
  failed: number;
  bytes: number;
  ms: number;
  mode: "lazy" | "all";
  util: number;
  particle: number;
};

type TexFrame = { x: number; y: number; width: number; height: number; [k: string]: unknown };
type Pixel = {
  width: number;
  height: number;
  rgba: Uint8Array;
  /** .tex 的像素格式号（0=ARGB8888 / 8=RG88 / 9=R8 …）：粒子路径要按 WE 的取样语义转换 */
  format?: number;
  /** .tex 的 TEXS 序列帧表（像素矩形）；图集尺寸挂在数组的 atlasWidth/atlasHeight 上 */
  frames?: TexFrame[];
  /** .tex flags bit1（TEXI clamp uvs）：效果链纹理绑定据此选 CLAMP/REPEAT */
  clampUvs?: boolean;
};

/** 已解码像素缓存：跨挂载复用（切壁纸 / 改画质不重新下载解码）。 */
const pixels = new Map<string, Pixel>();
/** 素材源信息（null = 本机没装素材 / 已关闭 / 还没探测；names 为空 = 只探到根、没拉贴图清单） */
let source: { id: string; names: Set<string> } | null = null;
/** 探测失败的挂载内缓存：同一次挂载里缺 N 个字体只发一次探测请求（resolveLocalAssetsMode 时重置） */
let probeFailed = false;
let eagerDone = false;
let inFlight: Promise<LocalAssetStats | null> | null = null;
let lastStats: LocalAssetStats | null = null;
/** 正在解码中的名字（同一张贴图被多处并发请求时合流） */
const pending = new Map<string, Promise<Pixel | null>>();

const BASE = "/api/local-assets";

/**
 * URL 参数档位（cfg.localAssets 未指定时的回落，见 resolveLocalAssetsMode）。
 * `fonts` 档 + `?fonts=1` 是 issue #24 加的：WE 内置字体不在壁纸 pkg 里，
 * 只想要官方字体时不该连带开启贴图的批量装载。
 */
function queryMode(): LocalAssetsMode {
  if (typeof location === "undefined") return "off";
  const q = new URLSearchParams(location.search);
  const la = q.get("localAssets");
  if (la === "0" || la === "off" || la === "false") return "off";
  if (la === "all") return "all";
  if (la === "fonts" || q.get("fonts") === "1" || q.get("fonts") === "true") return "fonts";
  if (la === "1" || la === "on" || la === "true") return "lazy";
  const dev = typeof import.meta !== "undefined" && (import.meta as any).env?.DEV;
  return dev ? "lazy" : "off";
}

/** 当前生效档位（installLocalAssets / fetchLocalAssetFile 共用；"off" = 不发任何请求） */
let activeMode: LocalAssetsMode = "off";

/**
 * 解析生效档位：cfg 显式值 > URL 参数 > dev 缺省。scene-mount 挂载期调用一次，
 * 结果存进 activeMode 供后续字体懒探测读取。
 */
export function resolveLocalAssetsMode(cfgMode?: LocalAssetsMode): LocalAssetsMode {
  activeMode = cfgMode ?? queryMode();
  probeFailed = false; // 新一次挂载允许重新探测（切了素材目录 / 刚装上素材）
  return activeMode;
}

/**
 * 探测素材根（只取 root id；名字清单是贴图路径才需要的，fonts 不用 —— issue #24：
 * 只实现 `/api/local-assets/local/<rel>` 路由、没有 materials 索引的宿主也能供字体）。
 * 幂等 + 并发合流；失败缓存到下次 resolveLocalAssetsMode（缺 N 个字体只发一次探测）。
 */
let probeInFlight: Promise<boolean> | null = null;
function probeRoot(): Promise<boolean> {
  if (source) return Promise.resolve(true);
  if (probeFailed) return Promise.resolve(false);
  if (!probeInFlight) {
    probeInFlight = (async () => {
      try {
        const res = await fetch(BASE, { cache: "no-store" });
        if (!res.ok) return false;
        const info = (await res.json()) as { ok?: boolean; roots?: Array<{ id: string; dir: string }> };
        if (!info?.ok || !info.roots?.length) return false;
        source = { id: info.roots[0].id, names: new Set() };
        return true;
      } catch {
        return false;
      } finally {
        if (!source) probeFailed = true;
        probeInFlight = null;
      }
    })();
  }
  return probeInFlight;
}

/**
 * 素材名清单（materials/index.json）。贴图路径（loadOne / 急切装载）依赖它；
 * 只取字体的路径不需要。在 installLocalAssets 里按需拉一次。
 */
async function loadMaterialNames(): Promise<boolean> {
  if (!source) return false;
  if (source.names.size) return true;
  try {
    const idxRes = await fetch(`${BASE}/${encodeURIComponent(source.id)}/materials/index.json`, {
      cache: "force-cache",
    });
    if (!idxRes.ok) return false;
    const idx = (await idxRes.json()) as { names?: string[] };
    if (!Array.isArray(idx.names) || !idx.names.length) return false;
    source.names = new Set(idx.names);
    return true;
  } catch {
    return false;
  }
}

/** 把 .tex 的 mip 解成 RGBA。内嵌 PNG/JPEG（Mirage 素材几乎全是这种）走位图解码。 */
async function mipToRgba(m: any): Promise<Pixel | null> {
  if (m && m.rgba) return { width: m.width, height: m.height, rgba: m.rgba };
  const blobData: Uint8Array | undefined = m && (m.png || m.image);
  if (!blobData) return null;
  const isPng = !!m.png;
  if (!isPng && m.fif !== tex.FIF?.JPEG && m.fif !== tex.FIF?.PNG) return null;
  const blob = new Blob([blobData as BlobPart], { type: isPng ? "image/png" : "image/jpeg" });
  // premultiplyAlpha:"none" —— 与 pkg 贴图同一条契约（见 scene-mount 里的长注释：
  // 预乘会让半透明边缘的 rgb 被乘两次）。
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: "none" });
  const w = bmp.width;
  const h = bmp.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0);
  if (typeof bmp.close === "function") bmp.close();
  const id = ctx.getImageData(0, 0, w, h);
  const rgba = new Uint8Array(w * h * 4);
  rgba.set(id.data);
  return { width: w, height: h, rgba };
}

async function fetchTex(url: string): Promise<Pixel | null> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  const parsed = tex.parseTex(buf);
  const mips = tex.decodeMips(parsed) as any[];
  if (!mips.length) return null;
  // mip0 即可：消费方（util 注册 / 粒子贴图）本来就用单级 + generateMipmap
  const px = await mipToRgba(mips[0]);
  if (!px) return null;
  px.format = parsed.format;
  // .tex flags bit1 = TEXI「clamp uvs」：与 .tex-json clampuvs 布尔一致
  // （229 张官方素材零反例）。效果链纹理绑定据此选 CLAMP/REPEAT，如
  // particle/halo_6 必须 CLAMP，否则 xray 开窗无限平铺（2212279721）。
  px.clampUvs = (Number(parsed.flags) & 2) !== 0;
  // TEXS 序列帧表：官方粒子图集（rain_drops_sheet 16 帧、fog1 64 帧、rain1 4 帧）
  // 全靠它切图。不传的话粒子只能按 sequencemultiplier 猜 N×N 方格 —— 一颗粒子
  // 会把整张图集当一帧采样，画面变成一坨糊（实测 3801012392）。
  const list = parsed.frames?.list as TexFrame[] | undefined;
  if (list && list.length) {
    (list as unknown as Record<string, unknown>).atlasWidth = px.width;
    (list as unknown as Record<string, unknown>).atlasHeight = px.height;
    px.frames = list;
  }
  return px;
}

/** 并发上限跑一批任务（本地磁盘 + 位图解码，8 路足够且不堵 UI） */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, Math.max(1, items.length))).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function loadOne(name: string): Promise<Pixel | null> {
  const hit = pixels.get(name);
  if (hit) return hit;
  if (!source || !source.names.has(name)) return null;
  const running = pending.get(name);
  if (running) return running;
  const url = `${BASE}/${encodeURIComponent(source.id)}/materials/${name
    .split("/")
    .map(encodeURIComponent)
    .join("/")}.tex`;
  const task = (async () => {
    try {
      const px = await fetchTex(url);
      if (px) pixels.set(name, px);
      return px;
    } catch {
      return null;
    } finally {
      pending.delete(name);
    }
  })();
  pending.set(name, task);
  return task;
}

/**
 * 探测素材源 + 装载 util 子树 + 装上 provider（幂等，可并发合流）。
 * 没有素材、被关闭、环境不支持 → 返回 null，调用方照常走程序化复刻。
 *
 * [issue #24] `cfgMode`（`WallpaperConfig.localAssets`，显式值优先于 URL 参数）：
 *   - `"off"`：不发任何请求，返回 null；
 *   - `"fonts"`：**只探测素材根**（供 fetchLocalAssetFile 按名取 `fonts/*`），
 *     不拉贴图清单、不装 provider —— 字体不该被贴图的批量装载绑架，
 *     公共贴图继续走程序化复刻；
 *   - `"lazy"` / `"all"`：与原行为一致（贴图 + 字体都可达）。
 */
export async function installLocalAssets(cfgMode?: LocalAssetsMode): Promise<LocalAssetStats | null> {
  const mode = resolveLocalAssetsMode(cfgMode);
  if (mode === "off") return null;
  if (mode === "fonts") {
    // 只探根（materials/index.json 是贴图清单，fonts 路径不需要）。
    // probeRoot 幂等 + 失败缓存，这里 await 一次即完成字体通路的全部准备。
    await probeRoot();
    return null;
  }
  if (eagerDone) return lastStats;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<LocalAssetStats | null> => {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    // 1) 探测源 + 素材名清单：端点不存在（生产 / 没装素材）就静默回落。
    //    探测失败写进 probeFailed，同一次挂载里后续字体懒探测不再重复发请求。
    if (!(await probeRoot())) return null;
    if (!(await loadMaterialNames())) return null;

    // 3) provider 必须先装：util 注册循环、粒子取贴图都会立刻问它
    sysTex.setSystemTextureProvider((name: string) => pixels.get(name) ?? null);
    ptex.setParticleTextureProvider((name: string) => pixels.get(name) ?? null);
    // gradient/gradient_*（shimmer 等效果的 gradient map 默认值）同构覆盖：
    // 本机拷了原版 materials/gradient/*.tex 时命中官方像素，否则程序化复刻兜底。
    gtex.setGradientTextureProvider((name: string) => pixels.get(name) ?? null);
    // pattern/voronoi[_local]（watercaustics 的槽 2/5 默认值）同构覆盖：本机拷了
    // 原版 materials/pattern/*.tex 时命中官方像素（含 flags→clampUvs=REPEAT），
    // 否则 pattern-textures.js 的程序化复刻兜底。
    patTex.setPatternTextureProvider((name: string) => pixels.get(name) ?? null);

    // 4) 急切装载：util（默认）或全量（mode=all）。source 是模块级可变量，
    //    await 之后 TS 不再收窄，取局部快照。
    const src = source;
    if (!src) return null;
    const utilNames = [...src.names].filter((n) => n.startsWith("util/"));
    const wanted = mode === "all" ? [...src.names] : utilNames;
    let failed = 0;
    await mapLimit(wanted, 8, async (n) => {
      const px = await loadOne(n);
      if (!px) failed++;
    });

    eagerDone = true;
    let util = 0;
    let particle = 0;
    let bytes = 0;
    for (const [n, px] of pixels) {
      bytes += px.rgba.byteLength;
      if (n.startsWith("util/")) util++;
      else if (n.startsWith("particle/")) particle++;
    }
    const stats: LocalAssetStats = {
      source: src.id,
      available: src.names.size,
      requested: wanted.length,
      loaded: pixels.size,
      failed,
      bytes,
      ms: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0),
      mode: mode === "all" ? "all" : "lazy",
      util,
      particle,
    };
    lastStats = stats;
    (globalThis as Record<string, unknown>).__localAssets = stats;
    return stats;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * 按需装载一张引擎内置贴图（粒子路径用：`loadParticleTex` 本来就是 async）。
 * 已在缓存 / 素材里没有这个名字 → 立即返回 false（调用方继续走程序化复刻）。
 */
export async function ensureLocalAsset(name: string): Promise<boolean> {
  if (typeof name !== "string" || !name) return false;
  if (pixels.has(name)) return true;
  if (!source) return false;
  const px = await loadOne(name);
  if (!px) return false;
  const st = lastStats;
  if (st) {
    st.loaded = pixels.size;
    st.bytes += px.rgba.byteLength;
    if (name.startsWith("util/")) st.util++;
    else if (name.startsWith("particle/")) st.particle++;
    (globalThis as Record<string, unknown>).__localAssets = st;
  }
  return true;
}

/** 原始文件字节缓存（fonts 等非贴图后备），按素材根相对路径存。 */
const files = new Map<string, Uint8Array>();

/**
 * 取素材树里的原始文件字节（非贴图路径：scene-mount 的字体装配拉 `fonts/*.ttf`）。
 * 素材没装 / 路径不存在 → null，调用方继续走自己的兜底（系统字体）。
 *
 * [issue #24] 贴图通路没装（installLocalAssets 没跑 / 档位是 fonts / 贴图清单缺失）
 * 也会在这里懒探测素材根 —— 字体只依赖「根可达」，不依赖贴图清单。档位为 off
 * （生产构建缺省）时不发任何请求，维持「库不联网」契约。
 */
export async function fetchLocalAssetFile(rel: string): Promise<Uint8Array | null> {
  if (!rel || rel.includes("..")) return null;
  if (!source) {
    if (activeMode === "off") return null;
    if (!(await probeRoot())) return null;
  }
  const sid = source!.id; // probeRoot 成功后 source 必非空（模块级 let，TS 不跨 await 收窄）
  const hit = files.get(rel);
  if (hit) return hit;
  try {
    const url = `${BASE}/${encodeURIComponent(sid)}/${rel
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    files.set(rel, buf);
    return buf;
  } catch {
    return null;
  }
}

/** 调试 / 测试用：已装载的引擎素材名单 */
export function loadedLocalAssetNames(): string[] {
  return [...pixels.keys()];
}

/**
 * 已探测到的素材根 id（null = 没装素材 / 档位 off / 探测失败）。
 * scene-mount 用它给 fonts 档发一条「字体通路可达」的 info 诊断（issue #24）。
 */
export function localAssetsSourceId(): string | null {
  return source ? source.id : null;
}
