#!/usr/bin/env node
/**
 * headless-gpu —— 真 GPU 无头 Chrome 驱动（we-scene 调试 / 截图 / 探针）。
 *
 * 为什么存在：
 *   `--use-angle=swiftshader --enable-unsafe-swiftshader` 把 WebGL 按回**纯 CPU 软件光栅化**，
 *   GPU 子进程实测能烧到 683% CPU（2026-09-20 现场：pid 22762 = 702%，8 个兄弟进程全 0%）。
 *   无头 Chrome 本来就能调真 GPU（Chrome for Testing + `--headless=new` 不加任何 GL flag
 *   即 `ANGLE Metal Renderer`）。本脚本统一走 `--use-angle=metal`，并把「后端不是真 GPU」
 *   变成**硬失败**，而不是让性能悄悄退化十倍。
 *
 * 覆盖：
 *   1. 后端断言：UNMASKED_RENDERER_WEBGL 命中 SwiftShader/llvmpipe 即抛错（`--software` 才放行）
 *   2. task 级 user-data-dir（<tmp>/we-headless/<task>-<pid>）：能区分是哪次任务留下的
 *   3. 四重清理：finally + exit/SIGINT/SIGTERM + 启动时清扫历史孤儿 + kill 整个进程组
 *      （驱动脚本异常退出会把浏览器交给 launchd 收养 → PPID=1，页面 rAF 永不停，
 *       GPU 进程崩了还会自动重启，就是那个无人管的 700% CPU 常驻）
 *   4. 进程树 CPU：CDP `SystemInfo.getProcessInfo` 的 cpuTime 差值、按 type 分组（GPU 项即元凶）
 *   5. 截图计时 + 就绪轮询：量的是**真实光栅化成本**（headless 的 rAF 被钉在 60fps 且
 *      无人消费像素时光栅化会被跳过，所以 rAF fps 不构成判据）
 *
 * 用法：
 *   node scripts/headless-gpu.mjs http://localhost:1430/ --task we344 --shots 20 --out /tmp/we344
 *   node scripts/headless-gpu.mjs --sweep-only          # 只清扫历史孤儿
 *   node scripts/headless-gpu.mjs <url> --wait 'window.__wpStats.frame().fps > 0'
 *   import { launchHeadless } from "./headless-gpu.mjs";   // 当库用
 *
 * 无 GPU 的机器（CI / 虚拟机）加 `--software` 逃生，但要知道它会慢十倍且像素与 Metal 不一致。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROFILE_ROOT = path.join(os.tmpdir(), "we-headless");
/** profile 单独一层：清扫只碰这里，绝不动同根下的截图输出目录。 */
const PROFILE_DIR_ROOT = path.join(PROFILE_ROOT, "profiles");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 进程内所有活跃 session：进程退出时也要把浏览器带走，别留孤儿。 */
const liveSessions = new Set();

/** 已被 launchd 收养、无人可管的常驻 GPU 进程：先清场再干活。 */
export function sweepOrphans({ quiet = false } = {}) {
  const killed = [];
  const res = spawnSync("pgrep", ["-lf", PROFILE_DIR_ROOT], { encoding: "utf8" });
  const owner = new Set(); // user-data-dir 仍在被引用的目录名
  for (const line of (res.stdout || "").split("\n")) {
    if (!line.trim()) continue;
    const pid = Number(line.split(" ", 1)[0]);
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    // 只认真正把我们的目录当 user-data-dir 的浏览器进程，别误伤刚好提到这个路径的 shell
    const m = line.match(new RegExp(`--user-data-dir=${PROFILE_DIR_ROOT}/([^\\s/]+)`));
    if (!m) continue;
    try {
      process.kill(pid, "SIGKILL");
      killed.push(pid);
    } catch {
      owner.add(m[1]); // 杀不掉说明还活着，保留它的 profile 目录
    }
  }
  if (killed.length) {
    sleepSync(400);
    for (const pid of killed) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  }

  const removed = [];
  if (fs.existsSync(PROFILE_DIR_ROOT)) {
    for (const name of fs.readdirSync(PROFILE_DIR_ROOT)) {
      if (owner.has(name)) continue;
      try {
        fs.rmSync(path.join(PROFILE_DIR_ROOT, name), { recursive: true, force: true });
        removed.push(name);
      } catch {}
    }
  }
  if (!quiet && (killed.length || removed.length)) {
    console.log(
      `[headless-gpu] 清扫历史孤儿：kill ${killed.length} 个进程、删 ${removed.length} 个 profile` +
        (killed.length ? `（pid ${killed.join(", ")}）` : ""),
    );
  }
  return { killed, removed };
}

/** 找一个**完整**的 Chrome 构建；chrome-headless-shell 只作兜底（它默认 SwiftShader）。 */
export function findChrome(explicit) {
  const cands = [];
  const push = (p) => p && cands.push(p);
  push(explicit);
  push(process.env.WE_CHROME);
  push(process.env.CHROME_BIN);

  const pwRoot = path.join(os.homedir(), "Library/Caches/ms-playwright");
  if (fs.existsSync(pwRoot)) {
    const dirs = fs
      .readdirSync(pwRoot)
      .filter((d) => /^chromium-\d+$/.test(d)) // 故意排除 chromium_headless_shell-*
      .sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
    for (const d of dirs) {
      for (const sub of ["chrome-mac-arm64", "chrome-mac-x64", "chrome-linux", "chrome-win"]) {
        push(path.join(pwRoot, d, sub, "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"));
        push(path.join(pwRoot, d, sub, "chrome"));
        push(path.join(pwRoot, d, sub, "chrome.exe"));
      }
    }
  }
  push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  push("/Applications/Chromium.app/Contents/MacOS/Chromium");
  push("/usr/bin/google-chrome");
  push("/usr/bin/chromium");
  for (const c of cands) if (fs.existsSync(c)) return { bin: c, headlessShell: false };

  // 兜底：headless shell 也支持 --use-angle=metal，但值得告警
  const res = spawnSync("bash", ["-c", `ls -d "${pwRoot}"/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | tail -1`], {
    encoding: "utf8",
  });
  const shell = (res.stdout || "").trim();
  if (shell && fs.existsSync(shell)) return { bin: shell, headlessShell: true };

  throw new Error(
    "找不到可用的 Chrome/Chromium。用 --bin <路径> 或 WE_CHROME=<路径> 指定；" +
      "Playwright 缓存里应存在 chromium-*/chrome-mac-arm64/Google Chrome for Testing.app",
  );
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const CDP_TIMEOUT_MS = 30000;

/** 一条 CDP 连接（WebSocket + id 配对 + 超时）。 */
class Cdp {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.n = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const slot = this.pending.get(m.id);
      if (!slot) return;
      this.pending.delete(m.id);
      clearTimeout(slot.timer);
      m.error ? slot.reject(new Error(`${this.label} ${slot.method}: ${m.error.message}`)) : slot.resolve(m.result);
    });
    ws.addEventListener("close", () => {
      for (const [, slot] of this.pending) {
        clearTimeout(slot.timer);
        slot.reject(new Error(`${this.label} 连接已关闭（${slot.method}）`));
      }
      this.pending.clear();
    });
  }

  static async connect(url, label, timeoutMs = CDP_TIMEOUT_MS) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} 连接超时`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`${label} 连接失败`));
      });
    });
    return new Cdp(ws, label);
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/**
 * 启动一个真 GPU 无头浏览器并连上 CDP。返回的 session 用完必须 `close()`
 * （CLI 里走 finally；库用法建议 try/finally）。
 *
 * 先用 Chrome 自带沙箱；**被外层沙箱/容器包裹时 Chrome 沙箱会初始化失败**
 * （`Failed to initialize sandbox` / `GPU process isn't usable`），此时自动降级
 * `--no-sandbox` 重试一次并在 stderr 告警 —— 安全默认 + 仍然能用，而不是把不安全默认写死。
 */
export async function launchHeadless(opts = {}) {
  try {
    return await launchOnce({ ...opts, noSandbox: opts.noSandbox ?? false });
  } catch (err) {
    if (opts.noSandbox || !/sandbox|gpu process isn't usable/i.test(err.message)) throw err;
    console.error(
      "[headless-gpu] Chrome 沙箱初始化失败（常见于被外层沙箱/容器包裹），" +
        "改用 --no-sandbox 重试一次；正常终端里建议不要加 --no-sandbox。",
    );
    return await launchOnce({ ...opts, noSandbox: true, sandboxFallback: true });
  }
}

async function launchOnce({
  url = "about:blank",
  task = `task-${Date.now().toString(36)}`,
  width = 1280,
  height = 720,
  software = false,
  gpuRequired = !software,
  keep = false,
  bin,
  port,
  extraArgs = [],
  noSandbox = false,
  sandboxFallback = false,
  readyTimeoutMs = 30000,
  onStderr,
} = {}) {
  if (typeof WebSocket === "undefined") {
    throw new Error("需要 Node ≥ 22（内置 WebSocket / fetch）");
  }
  sweepOrphans();

  const { bin: chrome, headlessShell } = findChrome(bin);
  const profileDir = path.join(PROFILE_DIR_ROOT, `${task}-${process.pid}`);
  fs.mkdirSync(profileDir, { recursive: true });
  const debugPort = port || (await freePort());

  const glArgs = software
    ? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--use-angle=metal"]; // ← 真 GPU。绝不能顺手加 --enable-unsafe-swiftshader
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-crash-reporter",
    "--disable-breakpad",
    `--crash-dumps-dir=${profileDir}/crash`, // 默认会往 ~/Library/.../Crashpad 写，沙箱下必被拒
    ...glArgs,
    ...(noSandbox ? ["--no-sandbox"] : []),
    ...extraArgs,
    "about:blank", // 目标页稍后用 Target.createTarget 建，避免「猜哪个 page target」的歧义
  ];

  let stderrTail = "";
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
    onStderr?.(chunk);
  });
  // 提前挂，免得浏览器在 CDP 起来之前就死了我们还在干等到超时
  let exited = null;
  child.once("exit", (code, sig) => {
    exited = `浏览器进程已退出（code=${code} signal=${sig}）`;
  });

  const session = {
    task,
    profileDir,
    debugPort,
    bin: chrome,
    headlessShell,
    software,
    noSandbox,
    sandboxFallback,
    child,
    renderer: null,
    closed: false,
  };

  const cleanup = ({ keepProfile = keep } = {}) => {
    if (session.closed) return;
    session.closed = true;
    session.pageCdp?.close();
    session.browserCdp?.close();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    try {
      child.kill("SIGTERM");
    } catch {}
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    try {
      child.kill("SIGKILL");
    } catch {}
    if (!keepProfile) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch {}
    }
  };
  session.close = async () => {
    cleanup();
    await sleep(150);
  };

  liveSessions.add(session);

  const fail = (err) => {
    cleanup();
    liveSessions.delete(session);
    const hint = stderrTail.trim() ? `\n--- chrome stderr（尾部）---\n${stderrTail.trim()}` : "";
    throw new Error(`${err.message}${hint}`);
  };

  try {
    // 等 CDP 端口起来；浏览器自己先死就立刻报错，别干等到超时
    const version = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < readyTimeoutMs) {
        if (exited) throw new Error(exited);
        try {
          const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
          if (r.ok) return await r.json();
        } catch {}
        await sleep(120);
      }
      throw new Error(`等 CDP 端口 ${debugPort} 超时 ${readyTimeoutMs}ms`);
    })();

    session.browserCdp = await Cdp.connect(version.webSocketDebuggerUrl, "browser");
    const { targetId } = await session.browserCdp.send("Target.createTarget", { url });

    // 用 targetId 精确取回这个页面的 ws，不靠 URL 匹配
    const pageTarget = await (async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        const t = list.find((x) => x.id === targetId && x.webSocketDebuggerUrl);
        if (t) return t;
        await sleep(100);
      }
      throw new Error("找不到刚创建的 page target");
    })();

    session.pageCdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl, "page");
    await session.pageCdp.send("Runtime.enable");
    await session.pageCdp.send("Page.enable");

    /** 新建一个独立 WebGL 上下文读后端串（不碰业务页面的上下文），读完即释放。 */
    session.probeRenderer = async () => {
      const { result } = await session.pageCdp.send("Runtime.evaluate", {
        expression: `(() => {
          const c = document.createElement("canvas");
          const gl = c.getContext("webgl2") || c.getContext("webgl");
          if (!gl) return "no-webgl";
          const d = gl.getExtension("WEBGL_debug_renderer_info");
          const r = d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
          const lose = gl.getExtension("WEBGL_lose_context");
          if (lose) lose.loseContext();
          return String(r);
        })()`,
        returnByValue: true,
      });
      return result.value;
    };

    /** 后端断言：软件渲染必须是显式选择，不能是事故。 */
    session.assertGpu = async () => {
      const renderer = await session.probeRenderer();
      session.renderer = renderer;
      const isSoftware = /swiftshader|llvmpipe|lavapipe|softpipe/i.test(renderer);
      if (isSoftware && gpuRequired) {
        throw new Error(
          `无头渲染后端是软件光栅化，拒绝继续：${renderer}\n` +
            "  去掉 --use-angle=swiftshader / --enable-unsafe-swiftshader" +
            "（后者是 Playwright 无头默认参数），改用 --use-angle=metal；\n" +
            "  确认没有走 chrome-headless-shell（它默认 SwiftShader）；\n" +
            "  无 GPU 机器确实需要软件渲染时显式加 --software。",
        );
      }
      return { renderer, software: isSoftware };
    };

    /** 内部用：直接 eval，不依赖 instrument() 才有的公开 API。 */
    const evalRaw = async (expression) => {
      const { result, exceptionDetails } = await session.pageCdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
      }
      return result.value;
    };

    // 先等页面加载完再断言后端，否则 about:blank 阶段读不出 WebGL（超时则放行，交给 --wait）
    if (url !== "about:blank") {
      const t0 = Date.now();
      while (Date.now() - t0 < readyTimeoutMs) {
        if (exited) throw new Error(exited);
        try {
          if (await evalRaw("document.readyState === 'complete'")) break;
        } catch {}
        await sleep(150);
      }
    }
    await session.assertGpu();

    return session;
  } catch (err) {
    fail(err);
  }
}

/**
 * 退出兜底。`exit` 钩子常驻（同步 kill，不改变进程语义，被当库引用时也安全）；
 * SIGINT/SIGTERM 只在 CLI 模式下接管，否则会抢掉调用方自己的信号处理。
 */
process.once("exit", () => {
  for (const s of liveSessions) {
    try {
      process.kill(-s.child.pid, "SIGKILL");
    } catch {}
  }
});

function installSignalHooks() {
  const bail = (sig) => () => {
    for (const s of liveSessions) {
      try {
        s.close?.();
      } catch {}
    }
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", bail("SIGINT"));
  process.once("SIGTERM", bail("SIGTERM"));
}

/** 给 CLI 用的一层薄封装：evaluate / waitFor / screenshot / CPU 计量。 */
export function instrument(session, { width = 1280, height = 720 } = {}) {
  session.width = width;
  session.height = height;

  session.evaluate = async (expression, { awaitPromise = false, timeoutMs = 30000 } = {}) => {
    const { result, exceptionDetails } = await session.pageCdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      timeoutMs,
    );
    if (exceptionDetails) {
      throw new Error(`页面表达式抛错：${exceptionDetails.exception?.description || exceptionDetails.text}`);
    }
    return result.value;
  };

  session.waitFor = async (expression, { timeoutMs = 30000, pollMs = 150 } = {}) => {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeoutMs) {
      try {
        last = await session.evaluate(expression);
        if (last) return last;
      } catch (e) {
        last = e.message;
      }
      await sleep(pollMs);
    }
    throw new Error(`等条件超时 ${timeoutMs}ms：${expression}（最后一次 ${JSON.stringify(last)}）`);
  };

  session.screenshot = async ({ out, format = "jpeg", quality = 85 } = {}) => {
    const { data } = await session.pageCdp.send("Page.captureScreenshot", { format, quality });
    if (out) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(data, "base64"));
    }
    return data;
  };

  /** 按 type 分组的 CPU 秒（GPU 那项就是软件渲染的元凶）。 */
  session.processInfo = async () => {
    const { processInfo } = await session.browserCdp.send("SystemInfo.getProcessInfo");
    const byType = {};
    let cpu = 0;
    for (const p of processInfo) {
      const t = p.type || "unknown";
      byType[t] = (byType[t] || 0) + p.cpuTime;
      cpu += p.cpuTime;
    }
    return { cpu: +cpu.toFixed(2), byType, processes: processInfo };
  };

  /** 量一段异步负载的进程树 CPU（不受机器上其他负载污染，也不需要 ps）。 */
  session.cpu = async (fn) => {
    const before = await session.processInfo();
    const t0 = Date.now();
    const result = await fn();
    const ms = Date.now() - t0;
    const after = await session.processInfo();
    const byType = {};
    for (const k of new Set([...Object.keys(before.byType), ...Object.keys(after.byType)])) {
      byType[k] = +((after.byType[k] || 0) - (before.byType[k] || 0)).toFixed(2);
    }
    const cpuSeconds = +(after.cpu - before.cpu).toFixed(2);
    return {
      ms,
      cpuSeconds,
      cpuPercent: ms > 0 ? +((cpuSeconds / (ms / 1000)) * 100).toFixed(0) : 0,
      byType,
      result,
    };
  };

  return session;
}

function parseArgs(argv) {
  const opts = { shots: 1, interval: 0, format: "jpeg", quality: 85, width: 1280, height: 720 };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--task": opts.task = next(); break;
      case "--shots": opts.shots = Number(next()); break;
      case "--interval": opts.interval = Number(next()); break;
      case "--out": opts.out = next(); break;
      case "--wait": opts.wait = next(); break;
      case "--wait-timeout": opts.readyTimeoutMs = Number(next()); break;
      case "--after": opts.after = Number(next()); break;
      case "--width": opts.width = Number(next()); break;
      case "--height": opts.height = Number(next()); break;
      case "--bin": opts.bin = next(); break;
      case "--port": opts.port = Number(next()); break;
      case "--format": opts.format = next(); break;
      case "--quality": opts.quality = Number(next()); break;
      case "--software": opts.software = true; break;
      case "--no-sandbox": opts.noSandbox = true; break;
      case "--keep": opts.keep = true; break;
      case "--sweep-only": opts.sweepOnly = true; break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) throw new Error(`未知参数 ${a}`);
        positional.push(a);
    }
  }
  opts.url = positional[0];
  return opts;
}

const HELP = `headless-gpu —— 真 GPU 无头 Chrome 驱动

  node scripts/headless-gpu.mjs <url> [选项]

    --task ID         任务名（进 user-data-dir 与默认输出目录），便于事后认领孤儿
    --shots N         截图张数（默认 1）
    --interval MS     截图间隔（默认 0 = 连拍）
    --out DIR         截图输出目录（默认 <tmp>/we-headless/<task>/shots）
    --wait EXPR       截图前等页面表达式为真，如 'window.__wpStats.frame().fps > 0'
    --after MS        截图前额外静置
    --width/--height  视口（默认 1280x720）
    --format/--quality  截图格式与质量（默认 jpeg/85）
    --bin PATH        指定浏览器（默认 Playwright 缓存的 Chrome for Testing）
    --port N          固定调试端口（默认自动挑空闲端口）
    --software        强制 SwiftShader（无 GPU 机器逃生口；慢十倍且像素不同）
    --no-sandbox      传 --no-sandbox（默认不传）
    --keep            保留 profile 目录（排查启动失败用）
    --sweep-only      只清扫历史孤儿进程/profile，不启动
    --json            机器可读输出
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || (!opts.url && !opts.sweepOnly)) {
    console.log(HELP);
    return opts.help ? 0 : 2;
  }
  if (opts.sweepOnly) {
    const r = sweepOrphans();
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }

  const task = opts.task || `shot-${Date.now().toString(36)}`;
  const outDir = opts.out || path.join(PROFILE_ROOT, task, "shots");
  const shots = Number.isFinite(opts.shots) && opts.shots > 0 ? Math.floor(opts.shots) : 1;
  let session;
  try {
    session = instrument(
      await launchHeadless({
        url: opts.url,
        task,
        width: opts.width,
        height: opts.height,
        software: opts.software,
        keep: opts.keep,
        bin: opts.bin,
        port: opts.port,
        noSandbox: opts.noSandbox,
        readyTimeoutMs: opts.readyTimeoutMs || 30000,
      }),
      { width: opts.width, height: opts.height },
    );

    if (opts.wait) await session.waitFor(opts.wait, { timeoutMs: opts.readyTimeoutMs || 60000 });
    if (opts.after) await sleep(opts.after);

    const metrics = await session.cpu(async () => {
      const files = [];
      for (let i = 0; i < shots; i++) {
        const ext = opts.format === "png" ? "png" : "jpg";
        const out = path.join(outDir, `shot-${String(i).padStart(3, "0")}.${ext}`);
        await session.screenshot({ out, format: opts.format, quality: opts.quality });
        files.push(out);
        if (opts.interval) await sleep(opts.interval);
      }
      return files;
    });

    const summary = {
      task,
      url: opts.url,
      renderer: session.renderer,
      backend: opts.software ? "swiftshader(显式)" : "gpu",
      headlessShell: session.headlessShell,
      noSandbox: session.noSandbox,
      sandboxFallback: session.sandboxFallback,
      bin: session.bin,
      viewport: `${opts.width}x${opts.height}`,
      shots,
      msPerShot: +(metrics.ms / shots).toFixed(1),
      cpuSeconds: metrics.cpuSeconds,
      cpuPercent: metrics.cpuPercent,
      cpuByType: metrics.byType,
      outDir,
      files: metrics.result,
    };

    if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`[headless-gpu] renderer : ${summary.renderer}`);
      console.log(`[headless-gpu] backend  : ${summary.backend}${session.headlessShell ? "（headless shell，建议换完整构建）" : ""}`);
      if (session.sandboxFallback) console.log("[headless-gpu] 提示     : 已降级 --no-sandbox（外层沙箱导致 Chrome 沙箱不可用）");
      console.log(
        `[headless-gpu] ${shots} 张截图 ${summary.msPerShot}ms/张，进程树 ${summary.cpuPercent}% CPU` +
          `（${summary.cpuSeconds}s，GPU ${summary.cpuByType.GPU ?? 0}s）`,
      );
      console.log(`[headless-gpu] 输出     : ${outDir}`);
    }
    // 软件渲染且未显式选择 = 事故（launchHeadless 已硬失败，这里兜住库用法之外的路径）
    if (!opts.software && /swiftshader/i.test(session.renderer || "")) return 1;
    return 0;
  } catch (err) {
    console.error(`[headless-gpu] 失败：${err.message}`);
    return 1;
  } finally {
    await session?.close();
  }
}

/** 只有被直接执行时才跑 CLI；被 import 时导出 API 即可。 */
const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  installSignalHooks();
  const code = await main();
  // 等一拍让 finally 的清理落地（profile 目录删除是同步的，这里只兜住 WS 关闭）
  await sleep(50);
  process.exit(code);
}
