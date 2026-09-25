/**
 * 贴图烘焙缓存（B3）—— 内嵌 PNG/JPEG 贴图的**预缩放产物**缓存。
 *
 * 问题：内嵌图的运行时路径是 `createImageBitmap(blob, { resize })`，浏览器会**先把整张
 * 图解出来再缩**。实测（trace，3662790108）最大一张输出只有 614×307 的图花了 697ms；
 * 52 张内嵌图的整体对比（真浏览器 + 引擎自己的解析代码）：
 *   全尺寸解码+缩放 470ms → 直解预缩放小图 **94ms（−80%）**，
 *   而且缓存产物比原图还小（30.7MB → 18.7MB，**×0.61**）。
 *
 * 安全契约（这条是全部前提）：缓存里存的是**处理完 EXIF 方向回滚之后**的那张最终位图，
 * 所以命中路径只做一次 `createImageBitmap`，像素与现状路径**逐位一致**。
 * 判据两层：`scripts/verify-bake.mjs`（离线，键/判定逻辑）+
 * `scripts/bake/run.mjs` 的 FBO 读回比对（真浏览器，52/52 逐位一致）。
 *
 * 开关：`MountOptions.bake`（默认开）/ `?bake=0` 关闭。关掉就走现状路径，零副作用。
 *
 * 为什么键里带**档位而不是图层足迹**：目标尺寸 = min(档位上限, 图层足迹)，而足迹随窗口
 * 尺寸变 —— 按足迹做键会让窗口一缩放就全量重烘。按**档位上限**烘（足迹只会更小），
 * 键就只跟壁纸/贴图/档位有关。代价是命中后的贴图可能比足迹需要的大一点，但上传很便宜
 * （实测 100~170MB 的上传只要 36~98ms），贵的恰恰是解码。
 */

export const BAKE_VERSION = 1;

/** 缓存后端：get/set 一个 PNG Blob。宿主可换实现（例如存到自己的目录） */
export type BakeCache = {
  /** 后端名（诊断用：cache-api = 跨启动持久，memory = 仅本页） */
  backend: "cache-api" | "memory";
  get(key: string): Promise<Blob | null>;
  set(key: string, blob: Blob): Promise<void>;
};

/**
 * 烘焙的**正式统计字段**（单一来源）。
 *
 * 它同时喂两处：`__memStats().bake`（结构化台账）与 reportDiag 的文本行 ——
 * 两者各记各的迟早会漂，所以只留这一份。宿主读 `window.__memStats().bake`
 * 就能拿到「命中多少 / 补烘多少 / 产物多大 / 后台花多久」。
 */
export type BakeStats = {
  enabled: boolean;
  backend: "cache-api" | "memory" | "off";
  hits: number;
  misses: number;
  baked: number;
  failed: number;
  bytes: number;
  ms: number;
};

/** 单张贴图的烘焙判定（纯函数，离线判据直接测它） */
export type BakeDecision = { bake: boolean; reason: string };

/**
 * 该不该烘一张**内嵌图**。
 *
 * 只在「确实能省」的时候烘：目标尺寸必须比原图小（否则预缩放不省解码），原图还得够大
 * （小图解码本来就便宜，烘它只会增加缓存条目）。视频 / 原始格式（DXT 等）不走这里 ——
 * 它们各有自己的路径（视频不需要，原始格式走压缩直传/选级，见 docs/BAKE-PLAN.md §3）。
 */
export function shouldBakeEmbedded(opts: {
  enabled: boolean;
  scale: number; // 目标尺寸 / 原生尺寸（<1 才有得省）
  nativeLong: number;
  srcBytes: number;
}): BakeDecision {
  if (!opts.enabled) return { bake: false, reason: "开关关闭（bake:false / ?bake=0）" };
  if (!(opts.scale > 0) || opts.scale >= 0.999) return { bake: false, reason: "目标尺寸未小于原图（预缩放不省解码）" };
  if (!(opts.nativeLong >= 512)) return { bake: false, reason: `原图太小（${opts.nativeLong}px < 512）` };
  if (!(opts.srcBytes >= 32 * 1024)) return { bake: false, reason: `原字节太少（${opts.srcBytes}B < 32KB）` };
  return { bake: true, reason: `预缩放 ${opts.nativeLong}px → ${(opts.nativeLong * opts.scale).toFixed(0)}px` };
}

/**
 * 便宜的指纹：够区分「同名但内容不同」即可（缓存键用，不做安全用途）。
 * 取首尾各 4KB + 长度做 FNV-1a —— 不必扫全字节，几百 MB 的 pkg 里逐字节 hash 不划算。
 */
export function quickHash(u8: Uint8Array): string {
  const h = (arr: Uint8Array, seed: number) => {
    let x = seed >>> 0;
    for (let i = 0; i < arr.length; i++) {
      x ^= arr[i];
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x >>> 0;
  };
  const head = u8.subarray(0, Math.min(4096, u8.length));
  const tail = u8.subarray(Math.max(0, u8.length - 4096));
  const a = h(head, 0x811c9dc5);
  const b = h(tail, a);
  const c = h(new Uint8Array([u8.length & 255, (u8.length >>> 8) & 255, (u8.length >>> 16) & 255]), b);
  return (c >>> 0).toString(16).padStart(8, "0") + u8.length.toString(16);
}

/**
 * 缓存键：`bake3/v1/<壁纸指纹>/<贴图指纹>/<档位>`。
 *
 * 档位（资源倍率 R）是唯一影响目标尺寸的量（图层足迹只会更小，见文件头注释）。
 * 版本号在路径里：改了烘焙产物格式就升 `BAKE_VERSION`，旧键自然失效。
 */
export function bakeCacheKey(parts: {
  wallKey: string;
  texName: string;
  srcBytes: Uint8Array;
  tier: number;
}): string {
  const wall = quickHash(new TextEncoder().encode(parts.wallKey));
  // 贴图身份 = 名字 + 内容：只用内容会撞（同字节不同名/不同声明尺寸的贴图会共用一份
  // 产物），名字必须参与键
  const tex = quickHash(
    new Uint8Array([
      ...new TextEncoder().encode(parts.texName),
      0,
      ...parts.srcBytes.subarray(0, 4096),
    ]),
  );
  const tier = Math.round(Math.max(0, Math.min(1, parts.tier)) * 100)
    .toString(16)
    .padStart(2, "0");
  return `bake3/v${BAKE_VERSION}/${wall}/${tex}/${tier}`;
}

/** 把最终位图编成 PNG（缓存产物）。PNG 无损 —— 这是像素等价的前提 */
export function bitmapToPngBlob(bmp: ImageBitmap): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      const cv = document.createElement("canvas");
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      if (!ctx) return resolve(null);
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bmp, 0, 0);
      cv.toBlob((b) => resolve(b), "image/png");
    } catch {
      resolve(null);
    }
  });
}

/**
 * 默认缓存后端：优先 Cache API（跨页面/跨启动持久，127.0.0.1 也算安全上下文），
 * 不可用时退回内存 Map（同页面内重复挂载仍受益）。
 */
export function defaultBakeCache(): BakeCache {
  const memory = new Map<string, Blob>();
  const cacheName = `webwallgl-bake-v${BAKE_VERSION}`;
  const hasCacheApi = typeof caches !== "undefined";
  return {
    backend: hasCacheApi ? "cache-api" : "memory",
    async get(key) {
      if (!hasCacheApi) return memory.get(key) ?? null;
      try {
        const c = await caches.open(cacheName);
        const hit = await c.match(key);
        return hit ? await hit.blob() : null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    async set(key, blob) {
      memory.set(key, blob); // 先进内存：同页面立刻可用
      if (!hasCacheApi) return;
      try {
        const c = await caches.open(cacheName);
        await c.put(key, new Response(blob));
      } catch {
        /* 存不下就只留在内存里 */
      }
    },
  };
}

/**
 * 烘焙队列：**首帧之后**才开跑（arm()），串行、逐条让出（条间 setTimeout），
 * 这样编码 PNG 的开销不会拖住加载期 —— 它只服务"下一次加载"，不服务当前这一次。
 */
export function createBakeQueue(opts: { stats: BakeStats; onDrained?: () => void }) {
  const stats = opts.stats;
  const jobs: Array<() => Promise<void>> = [];
  let armed = false;
  let running = false;
  const drain = async () => {
    if (running) return;
    running = true;
    while (jobs.length) {
      const job = jobs.shift()!;
      const t0 = performance.now();
      try {
        await job();
      } catch {
        stats.failed++;
      } finally {
        stats.ms += performance.now() - t0;
      }
      await new Promise((r) => setTimeout(r, 8)); // 逐条让出，别连着吃一整段主线程
    }
    running = false;
    try {
      opts.onDrained?.();
    } catch {
      /* 诊断回调不许影响烘焙 */
    }
  };
  return {
    enqueue(job: () => Promise<void>) {
      jobs.push(job);
      if (armed) void drain();
    },
    /** 首帧之后调用一次：从这以后才开始消化队列 */
    arm() {
      if (armed) return;
      armed = true;
      void drain();
    },
  };
}

export type BakeQueue = ReturnType<typeof createBakeQueue>;
