/**
 * 本机引擎内置素材（WE 安装目录的 `materials/**`：贴图 + 法线）接入。
 *
 * ## 为什么存在
 * 工坊壁纸的效果链 / 材质 / 粒子系统会按名字引用 WE 安装目录自带的公共贴图
 * （`util/white`、`util/flatnormal`、`particle/halo`、`particle/drop_normal` …），
 * 这些**不在壁纸 pkg 里**。仓库里没有官方字节（受版权保护，见 docs/COMPLIANCE.md），
 * 只用 system-textures.js / particle-textures.js 的程序化复刻顶上 —— 观感近似但
 * 逐像素对不上（法线参考、噪声颗粒、粒子精灵形状差异最明显）。
 *
 * 本模块是**本地测试用的可选通路**：谁本机有原版素材（拷到 `local-assets/mirage/`，
 * 或 `WE_LOCAL_ASSETS=/abs/path`），dev server 的 `/api/local-assets` 把它们喂过来，
 * 这里解码成 `{width,height,rgba}` 并经宿主 provider 注入引擎 → 渲染与官方对齐。
 * 没有素材时 `/api/local-assets` 返回 `{ok:false}`，本模块返回 null、引擎走程序化
 * 复刻，**行为与今天完全一致**。
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
 *   `?localAssets=0|off` 关闭；`all` 全量；`1|on` 或 dev 缺省 = util 急切 + particle 按需。
 *   只有 dev（`import.meta.env.DEV`）或显式参数才发请求，生产构建不会产生任何请求。
 */
import { tex, ptex, sysTex, gtex } from "./vendor";

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
};

/** 已解码像素缓存：跨挂载复用（切壁纸 / 改画质不重新下载解码）。 */
const pixels = new Map<string, Pixel>();
/** 素材源信息（null = 本机没装素材 / 已关闭 / 还没探测） */
let source: { id: string; names: Set<string> } | null = null;
let probed = false;
let eagerDone = false;
let inFlight: Promise<LocalAssetStats | null> | null = null;
let lastStats: LocalAssetStats | null = null;
/** 正在解码中的名字（同一张贴图被多处并发请求时合流） */
const pending = new Map<string, Promise<Pixel | null>>();

const BASE = "/api/local-assets";

function queryMode(): "off" | "lazy" | "all" {
  if (typeof location === "undefined") return "off";
  const q = new URLSearchParams(location.search).get("localAssets");
  if (q === "0" || q === "off" || q === "false") return "off";
  if (q === "all") return "all";
  if (q === "1" || q === "on" || q === "true") return "lazy";
  const dev = typeof import.meta !== "undefined" && (import.meta as any).env?.DEV;
  return dev ? "lazy" : "off";
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
 */
export async function installLocalAssets(): Promise<LocalAssetStats | null> {
  const mode = queryMode();
  if (mode === "off") return null;
  if (eagerDone) return lastStats;
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<LocalAssetStats | null> => {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    // 1) 探测源：端点不存在（生产 / 没装素材）就静默回落
    try {
      const res = await fetch(BASE, { cache: "no-store" });
      if (!res.ok) return null;
      const info = (await res.json()) as { ok?: boolean; roots?: Array<{ id: string; dir: string }> };
      if (!info?.ok || !info.roots?.length) return null;
      const root = info.roots[0];
      // 2) 素材名清单：dev server 扫盘给出（引擎名 = materials/ 下的相对路径去 .tex）
      const idxRes = await fetch(`${BASE}/${encodeURIComponent(root.id)}/materials/index.json`, {
        cache: "force-cache",
      });
      if (!idxRes.ok) return null;
      const idx = (await idxRes.json()) as { names?: string[] };
      if (!Array.isArray(idx.names) || !idx.names.length) return null;
      source = { id: root.id, names: new Set(idx.names) };
    } catch {
      return null;
    }

    // 3) provider 必须先装：util 注册循环、粒子取贴图都会立刻问它
    sysTex.setSystemTextureProvider((name: string) => pixels.get(name) ?? null);
    ptex.setParticleTextureProvider((name: string) => pixels.get(name) ?? null);
    // gradient/gradient_*（shimmer 等效果的 gradient map 默认值）同构覆盖：
    // 本机拷了原版 materials/gradient/*.tex 时命中官方像素，否则程序化复刻兜底。
    gtex.setGradientTextureProvider((name: string) => pixels.get(name) ?? null);

    // 4) 急切装载：util（默认）或全量（mode=all）
    const utilNames = [...source.names].filter((n) => n.startsWith("util/"));
    const wanted = mode === "all" ? [...source.names] : utilNames;
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
      source: source.id,
      available: source.names.size,
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

/** 调试 / 测试用：已装载的引擎素材名单 */
export function loadedLocalAssetNames(): string[] {
  return [...pixels.keys()];
}
