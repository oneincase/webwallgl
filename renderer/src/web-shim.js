/**
 * WE 网页壁纸兼容 shim（注入到 iframe，必须在作者脚本之前执行）。
 *
 * 语料：本机库 42 张 web 壁纸扫描（2026-09）——
 *   wallpaperPropertyListener 29 / RegisterAudioListener 22 /
 *   RequestRandomFileForProperty 8 / userDirectoryFiles* 9 /
 *   Media*Listener 2 / PluginListener 2
 *
 * 官方 CEF 在任何壁纸脚本前就把这些做成原生函数；工坊顶层直接注册。
 * 本文件作为 <head> 首个 classic script 插入。
 *
 * 父页控制面 __we*（main.ts weShimCall / web.ts 泵）：
 *   __weSetPaused / __weSetFps / __weSetVolume / __weApplyProps / __weSeedProps
 *   __wePushAudio(arr128)
 *   __wePushMedia(event)  — {op, payload} 见下
 *   __wePushDirectoryFiles(prop, files) / __weRemoveDirectoryFiles(prop, files)
 *   __weRewriteFileUrl(s) — file:/// → 同源相对（HTTP 页）；空 file:/// → ""
 *   __wePushPointer(x, y, buttons) / __wePointerLeave() — 外部指针注入（见文末）
 */
(function (w) {
  "use strict";
  try {
    if (w.document && w.document.documentElement) {
      w.document.documentElement.setAttribute("data-we-shim", "1");
    }
  } catch (_) {
    /* 忽略 */
  }

  var audioListener = null;
  var propertyListener = null;
  var paused = false;
  var fps = 60;
  var volume = 0;
  var pendingProps = null;
  var pendingGeneral = null;
  var rafMap = Object.create(null);
  var rafCounter = 0;
  var origRaf = w.requestAnimationFrame.bind(w);
  var origCaf = w.cancelAnimationFrame.bind(w);

  // 官方 CEF 以文件系统为源，作者普遍 `'file:///' + value`。HTTP 同源页里
  // file:///files/x.webm 加载失败；空 value 变成 file:///（1748506393）。
  // file: 协议页保持原样（真本地嵌入）。
  function rewriteBareFileUrl(url) {
    if (typeof url !== "string") return url;
    var s = url.trim();
    if (!/^file:/i.test(s)) return s;
    try {
      var loc = w.location;
      if (loc && loc.protocol === "file:") return s;
    } catch (_) {
      /* 忽略 */
    }
    var rest = s.replace(/^file:\/\//i, "").replace(/^\/+/, "");
    if (!rest) return "";
    if (/^[a-zA-Z][:|]/.test(rest)) return "";
    if (/^(Users|home|tmp|var|etc|private|Volumes)\//.test(rest)) return "";
    try {
      var href = w.location && w.location.href;
      if (href) return new URL(rest, href).href;
    } catch (_) {
      /* 忽略 */
    }
    return rest;
  }

  function rewriteWeFileUrl(input) {
    if (typeof input !== "string") return input;
    if (/url\(/i.test(input)) {
      return input.replace(/url\(\s*(['"]?)([^)'"]*?)\1\s*\)/gi, function (_m, q, inner) {
        var next = rewriteBareFileUrl(inner);
        if (!next) return "none";
        var quote = q || '"';
        return "url(" + quote + next + quote + ")";
      });
    }
    return rewriteBareFileUrl(input);
  }

  w.__weRewriteFileUrl = rewriteWeFileUrl;

  function installFileUrlHooks() {
    try {
      if (w.Element && w.Element.prototype && typeof w.Element.prototype.setAttribute === "function") {
        var origSetAttr = w.Element.prototype.setAttribute;
        w.Element.prototype.setAttribute = function (name, value) {
          var n = String(name || "").toLowerCase();
          if (n === "src" || n === "href" || n === "poster") value = rewriteWeFileUrl(value);
          return origSetAttr.call(this, name, value);
        };
      }
    } catch (_) {
      /* 无 DOM 的 verifier 跳过 */
    }
    var ctorNames = ["HTMLImageElement", "HTMLMediaElement", "HTMLSourceElement", "HTMLScriptElement"];
    for (var i = 0; i < ctorNames.length; i++) {
      try {
        var Ctor = w[ctorNames[i]];
        if (!Ctor || !Ctor.prototype) continue;
        var desc = Object.getOwnPropertyDescriptor(Ctor.prototype, "src");
        if (!desc || typeof desc.set !== "function") continue;
        (function (d) {
          Object.defineProperty(Ctor.prototype, "src", {
            configurable: true,
            enumerable: d.enumerable,
            get: d.get,
            set: function (v) {
              d.set.call(this, rewriteWeFileUrl(v));
            },
          });
        })(desc);
      } catch (_) {
        /* 忽略单个原型 */
      }
    }
    try {
      var styleDesc =
        w.HTMLElement && Object.getOwnPropertyDescriptor(w.HTMLElement.prototype, "style");
      // Chromium 的 backgroundImage 不是原型自有描述符，只能包 HTMLElement.style 的 Proxy。
      if (styleDesc && typeof styleDesc.get === "function" && w.Proxy && w.WeakMap) {
        var styleCache = new w.WeakMap();
        Object.defineProperty(w.HTMLElement.prototype, "style", {
          configurable: true,
          enumerable: styleDesc.enumerable,
          get: function () {
            var raw = styleDesc.get.call(this);
            if (!raw) return raw;
            var cached = styleCache.get(raw);
            if (cached) return cached;
            var proxy = new w.Proxy(raw, {
              set: function (target, prop, value) {
                if (typeof value === "string" && typeof prop === "string" && /background/i.test(prop)) {
                  value = rewriteWeFileUrl(value);
                }
                target[prop] = value;
                return true;
              },
              get: function (target, prop) {
                var v = target[prop];
                if (typeof v === "function") return v.bind(target);
                return v;
              },
            });
            styleCache.set(raw, proxy);
            return proxy;
          },
          set: styleDesc.set,
        });
      }
      var styleProto = w.CSSStyleDeclaration && w.CSSStyleDeclaration.prototype;
      if (styleProto && typeof styleProto.setProperty === "function") {
        var origSetProp = styleProto.setProperty;
        styleProto.setProperty = function (name, value, priority) {
          if (typeof value === "string" && /background/i.test(String(name || ""))) {
            value = rewriteWeFileUrl(value);
          }
          return origSetProp.call(this, name, value, priority);
        };
      }
    } catch (_) {
      /* 忽略 */
    }
  }
  installFileUrlHooks();

  // propertyName → string[]（绝对/相对路径；随机文件从此抽）
  var directoryFiles = Object.create(null);

  var mediaListeners = {
    properties: null,
    thumbnail: null,
    playback: null,
    timeline: null,
    status: null,
  };
  // 晚注册时回放最近一帧（作者脚本常在 DOMContentLoaded 后才 Register）
  var lastMedia = {
    properties: null,
    thumbnail: null,
    playback: null,
    timeline: null,
    status: null,
  };

  function callApplyUserProperties(props) {
    if (!propertyListener || typeof propertyListener.applyUserProperties !== "function") return;
    try {
      propertyListener.applyUserProperties(props || {});
    } catch (_) {
      /* 壁纸脚本抛错不打断宿主 */
    }
  }

  function callApplyGeneralProperties(props) {
    if (!propertyListener || typeof propertyListener.applyGeneralProperties !== "function") return;
    try {
      propertyListener.applyGeneralProperties(props || {});
    } catch (_) {
      /* 忽略 */
    }
  }

  function callSetPaused(v) {
    if (!propertyListener || typeof propertyListener.setPaused !== "function") return;
    try {
      propertyListener.setPaused(!!v);
    } catch (_) {
      /* 忽略 */
    }
  }

  function callDirectoryAdded(prop, files) {
    if (!propertyListener || typeof propertyListener.userDirectoryFilesAddedOrChanged !== "function")
      return;
    try {
      propertyListener.userDirectoryFilesAddedOrChanged(prop, files);
    } catch (_) {
      /* 忽略 */
    }
  }

  function callDirectoryRemoved(prop, files) {
    if (!propertyListener || typeof propertyListener.userDirectoryFilesRemoved !== "function") return;
    try {
      propertyListener.userDirectoryFilesRemoved(prop, files);
    } catch (_) {
      /* 忽略 */
    }
  }

  function flushPending() {
    if (pendingProps) {
      var p = pendingProps;
      pendingProps = null;
      callApplyUserProperties(p);
    }
    if (pendingGeneral) {
      var g = pendingGeneral;
      pendingGeneral = null;
      callApplyGeneralProperties(g);
    }
  }

  /**
   * 工坊常在 React render 里写 `window.wallpaperPropertyListener = {…}`（2905017768）。
   * 官方 CEF 不会在赋值当下同步回调 setPaused/apply*；若我们同步 flush，
   * 等于 render 中 setState → React 熔断 → #root 空（一片黑）。
   */
  function afterAssign(fn) {
    try {
      if (typeof w.queueMicrotask === "function") w.queueMicrotask(fn);
      else w.setTimeout(fn, 0);
    } catch (_) {
      try {
        fn();
      } catch (_) {
        /* 忽略 */
      }
    }
  }

  function safeCall(fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (_) {
      /* 忽略 */
    }
  }

  // —— 媒体集成枚举（3747222633：缺省时 PLAYBACK_PLAYING||0 会把「播放」当成 0）——
  w.wallpaperMediaIntegration = {
    PLAYBACK_STOPPED: 0,
    PLAYBACK_PLAYING: 1,
    PLAYBACK_PAUSED: 2,
  };

  // —— 官方 API：音频 ——
  w.wallpaperRegisterAudioListener = function (cb) {
    audioListener = typeof cb === "function" ? cb : null;
  };

  // —— 官方 API：媒体 ——
  w.wallpaperRegisterMediaPropertiesListener = function (cb) {
    mediaListeners.properties = typeof cb === "function" ? cb : null;
    if (mediaListeners.properties && lastMedia.properties) {
      safeCall(mediaListeners.properties, lastMedia.properties);
    }
  };
  w.wallpaperRegisterMediaThumbnailListener = function (cb) {
    mediaListeners.thumbnail = typeof cb === "function" ? cb : null;
    if (mediaListeners.thumbnail && lastMedia.thumbnail) {
      safeCall(mediaListeners.thumbnail, lastMedia.thumbnail);
    }
  };
  w.wallpaperRegisterMediaPlaybackListener = function (cb) {
    mediaListeners.playback = typeof cb === "function" ? cb : null;
    if (mediaListeners.playback && lastMedia.playback) {
      safeCall(mediaListeners.playback, lastMedia.playback);
    }
  };
  w.wallpaperRegisterMediaTimelineListener = function (cb) {
    mediaListeners.timeline = typeof cb === "function" ? cb : null;
    if (mediaListeners.timeline && lastMedia.timeline) {
      safeCall(mediaListeners.timeline, lastMedia.timeline);
    }
  };
  w.wallpaperRegisterMediaStatusListener = function (cb) {
    mediaListeners.status = typeof cb === "function" ? cb : null;
    if (mediaListeners.status && lastMedia.status) {
      safeCall(mediaListeners.status, lastMedia.status);
    }
  };

  // —— 官方 API：随机文件（slideshow）——
  // 回调签名：function(propertyName, filePath)。无库存文件时 filePath 为空串（语料 if(i) 守卫）。
  w.wallpaperRequestRandomFileForProperty = function (propertyName, callback) {
    if (typeof callback !== "function") return;
    var prop = String(propertyName || "");
    var list = directoryFiles[prop];
    var path = "";
    if (list && list.length) {
      path = String(list[(Math.random() * list.length) | 0] || "");
    }
    try {
      callback(prop, path);
    } catch (_) {
      /* 忽略 */
    }
  };

  // —— PropertyListener（getter/setter；回调延后到微任务，见 afterAssign）——
  // 官方在页面加载完成后才发全量属性/暂停状态；首屏脚本（body onLoad=init 等）常
  // 假设属性到达时 DOM/场景已初始化（827982449：applyUserProperties→cl() 在 load 前
  // 跑会撞上未创建的 scene/material）。未加载完成时等 window load + 一个宏任务
  // （保证排在 onLoad 属性处理器之后），已加载完成则微任务即发。
  function whenPageReady(fn) {
    var ready = "complete";
    try {
      ready = w.document.readyState;
    } catch (_) {
      /* 忽略 */
    }
    if (ready === "complete") {
      afterAssign(fn);
      return;
    }
    try {
      w.addEventListener("load", function () {
        // setTimeout 保证排在 load 同步链（onLoad 处理器）之后
        w.setTimeout(fn, 0);
      }, { once: true });
    } catch (_) {
      afterAssign(fn);
    }
  }
  Object.defineProperty(w, "wallpaperPropertyListener", {
    configurable: true,
    enumerable: true,
    get: function () {
      return propertyListener;
    },
    set: function (v) {
      var next = v && typeof v === "object" ? v : null;
      var prev = propertyListener;
      propertyListener = next;
      if (!next) return;
      // 仅首次注册补发挂载状态。官方 CEF 从不在赋值当下回调；2905017768 等 React 壁纸在
      // 渲染体里重新赋值（新对象字面量），若每次都补 setPaused 会形成
      // 渲染 → 赋值 → 补发 setState → 再渲染 的微任务死循环（点下一曲整页卡死）。
      if (prev) return;
      whenPageReady(function () {
        flushPending();
        callApplyGeneralProperties({ fps: fps });
        callSetPaused(paused);
        // 已缓存的目录文件补推一次（作者可能后挂 userDirectoryFilesAddedOrChanged）
        for (var prop in directoryFiles) {
          if (Object.prototype.hasOwnProperty.call(directoryFiles, prop) && directoryFiles[prop].length) {
            callDirectoryAdded(prop, directoryFiles[prop].slice());
          }
        }
      });
    },
  });

  // —— Plugin（iCUE 等；无硬件时空实现，避免 if 判断失败）——
  if (!w.wallpaperPluginListener) {
    w.wallpaperPluginListener = {
      onPluginLoaded: function () {},
    };
  }

  // —— 定时器冻结：官方暂停 = "fully freeze the process that renders the wallpaper"，
  // rAF 已在节流层挂起，这里冻结定时器：暂停期间新建的挂起登记、恢复时按原延迟/间隔
  // 重新启动；**已启动**的真定时器到期由包装回调拦下——timeout 转挂起（恢复后立即补跑，
  // 近似官方的剩余等待），interval 直接跳过该周期（恢复后从下个周期继续）。
  var pendTimers = [];
  var tmSeq = 0;
  var TM_BASE = 0x40000000; // 假 id 段，避免与真实 timer id 混淆
  var origST = w.setTimeout;
  var origSI = w.setInterval;
  var origCTO = w.clearTimeout;
  var origCIT = w.clearInterval;
  function guardTimeout(fn) {
    if (typeof fn !== "function") return fn;
    return function () {
      if (paused) {
        pendTimers.push({ id: 0, kind: "t", fn: fn, ms: 1, extra: [] });
        return;
      }
      return fn.apply(this, arguments);
    };
  }
  function guardInterval(fn) {
    if (typeof fn !== "function") return fn;
    return function () {
      if (paused) return;
      return fn.apply(this, arguments);
    };
  }
  function startTimer(kind, fn, ms, extra) {
    if (paused) {
      var id = TM_BASE + ++tmSeq;
      pendTimers.push({ id: id, kind: kind, fn: fn, ms: ms, extra: extra });
      return id;
    }
    var args = [kind === "t" ? guardTimeout(fn) : guardInterval(fn), ms].concat(extra);
    return (kind === "t" ? origST : origSI).apply(w, args);
  }
  w.setTimeout = function (fn, ms) {
    return startTimer("t", fn, ms, Array.prototype.slice.call(arguments, 2));
  };
  w.setInterval = function (fn, ms) {
    return startTimer("i", fn, ms, Array.prototype.slice.call(arguments, 2));
  };
  function unpend(id) {
    for (var i = 0; i < pendTimers.length; i++) {
      if (pendTimers[i].id === id) {
        pendTimers.splice(i, 1);
        return true;
      }
    }
    return false;
  }
  w.clearTimeout = function (id) {
    if (unpend(id)) return;
    origCTO.call(w, id);
  };
  w.clearInterval = function (id) {
    if (unpend(id)) return;
    origCIT.call(w, id);
  };
  function resumeTimers() {
    var list = pendTimers;
    pendTimers = [];
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      (t.kind === "t" ? origST : origSI).call(w, t.fn, t.ms, t.extra);
    }
  }

  // —— 媒体音量：对齐官方 CEF 语义（浏览器级主音量与作者页面内音量独立相乘）——
  // 作者常在播放前重设 a.volume = uiVolume（Bocchi），且音频多为 `new Audio()` 不进
  // DOM——querySelectorAll 找不到、直接覆盖 volume 又会被作者回写。因此 hook 原型：
  // setter 记作者值，元素实际音量 = 作者值 × 主音量；`__weSetVolume` 改系数并刷新
  // 全部活实例（DOM 内 + Audio 构造器登记的 WeakRef）。
  var hostVolume = 1;
  var liveMedia = []; // WeakRef<HTMLMediaElement>
  function trackMedia(el) {
    if (!w.WeakRef) return;
    liveMedia.push(new w.WeakRef(el));
  }
  function applyMediaVolume(el) {
    if (el.__weBaseVol != null) {
      mediaVolDesc.set.call(el, el.__weBaseVol * hostVolume);
    } else {
      mediaVolDesc.set.call(el, hostVolume);
    }
    var baseMuted = !!el.__weBaseMuted;
    mediaMutedDesc.set.call(el, baseMuted || hostVolume <= 0);
  }
  function refreshAllMediaVolume() {
    try {
      var nodes = w.document.querySelectorAll("audio,video");
      for (var i = 0; i < nodes.length; i++) applyMediaVolume(nodes[i]);
    } catch (_) {
      /* 忽略 */
    }
    for (var j = liveMedia.length - 1; j >= 0; j--) {
      var el = liveMedia[j].deref();
      if (!el) {
        liveMedia.splice(j, 1);
        continue;
      }
      applyMediaVolume(el);
    }
  }
  var mediaVolDesc = null;
  var mediaMutedDesc = null;
  function installMediaVolumeHooks() {
    try {
      if (!w.HTMLMediaElement || !w.HTMLMediaElement.prototype) return;
      var proto = w.HTMLMediaElement.prototype;
      mediaVolDesc = Object.getOwnPropertyDescriptor(proto, "volume");
      mediaMutedDesc = Object.getOwnPropertyDescriptor(proto, "muted");
      if (mediaVolDesc && typeof mediaVolDesc.set === "function") {
        Object.defineProperty(proto, "volume", {
          configurable: true,
          enumerable: mediaVolDesc.enumerable,
          get: function () {
            return this.__weBaseVol != null ? this.__weBaseVol : mediaVolDesc.get.call(this);
          },
          set: function (v) {
            this.__weBaseVol = Math.max(0, Math.min(1, Number(v) || 0));
            mediaVolDesc.set.call(this, this.__weBaseVol * hostVolume);
          },
        });
      }
      if (mediaMutedDesc && typeof mediaMutedDesc.set === "function") {
        Object.defineProperty(proto, "muted", {
          configurable: true,
          enumerable: mediaMutedDesc.enumerable,
          get: function () {
            return this.__weBaseMuted != null
              ? this.__weBaseMuted || hostVolume <= 0
              : mediaMutedDesc.get.call(this);
          },
          set: function (v) {
            this.__weBaseMuted = !!v;
            mediaMutedDesc.set.call(this, !!v || hostVolume <= 0);
          },
        });
      }
      // `new Audio()` 不进 DOM：构造器登记 WeakRef 以便主音量变化时刷新
      if (typeof w.Audio === "function" && w.WeakRef) {
        var OrigAudio = w.Audio;
        function WrappedAudio(src) {
          var a = new OrigAudio(src);
          trackMedia(a);
          applyMediaVolume(a);
          return a;
        }
        WrappedAudio.prototype = OrigAudio.prototype;
        w.Audio = WrappedAudio;
      }
    } catch (_) {
      /* 无媒体环境的 verifier 跳过 */
    }
  }
  installMediaVolumeHooks();

  // —— 父页控制面 ——
  // 官方 setPaused 只在暂停状态实际变化时调用一次；重复调用去重。
  // 暂停还要冻结页内媒体：官方是进程级冻结（无声、解码器可回收），作者的
  // setPaused 常只管自己的逻辑。只记录「我们代为暂停」的元素，恢复时仅还原这部分，
  // 不碰作者自己暂停的。
  var weFrozenMedia = [];
  function freezePageMedia() {
    weFrozenMedia.length = 0;
    try {
      var nodes = w.document.querySelectorAll("audio,video");
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i].paused) {
          weFrozenMedia.push(nodes[i]);
          try {
            nodes[i].pause();
          } catch (_) {
            /* 忽略 */
          }
        }
      }
    } catch (_) {
      /* 忽略 */
    }
  }
  function thawPageMedia() {
    for (var i = 0; i < weFrozenMedia.length; i++) {
      try {
        var p = weFrozenMedia[i].play();
        if (p && p.catch) p.catch(function () {});
      } catch (_) {
        /* 忽略 */
      }
    }
    weFrozenMedia.length = 0;
  }
  w.__weSetPaused = function (v) {
    var next = !!v;
    if (next === paused) return;
    paused = next;
    if (paused) {
      callSetPaused(true);
      freezePageMedia();
    } else {
      callSetPaused(false);
      thawPageMedia();
      resumeTimers();
    }
  };

  w.__weSetFps = function (n) {
    var next = Number(n);
    if (!Number.isFinite(next) || next <= 0) return;
    fps = next;
    callApplyGeneralProperties({ fps: fps });
  };

  w.__weSetVolume = function (v) {
    var next = Math.max(0, Math.min(1, Number(v) || 0));
    volume = next;
    hostVolume = next;
    refreshAllMediaVolume();
  };

  w.__weApplyProps = function (props) {
    if (!props || typeof props !== "object") return;
    // file 属性：值是路径时登记进随机池（单文件 slideshow）
    try {
      for (var key in props) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) continue;
        var ent = props[key];
        var val = ent && typeof ent === "object" && "value" in ent ? ent.value : ent;
        if (typeof val === "string" && val !== "" && /\.(png|jpe?g|gif|webp|webm|mp4|bmp)$/i.test(val)) {
          directoryFiles[key] = [val];
        }
      }
    } catch (_) {
      /* 忽略 */
    }
    if (!propertyListener || typeof propertyListener.applyUserProperties !== "function") {
      pendingProps = props;
      return;
    }
    callApplyUserProperties(props);
  };

  w.__weSeedProps = function (props) {
    if (!props || typeof props !== "object") return;
    if (propertyListener && typeof propertyListener.applyUserProperties === "function") {
      w.__weApplyProps(props);
    } else {
      pendingProps = props;
    }
  };

  w.__wePushAudio = function (arr) {
    if (paused || !audioListener) return;
    try {
      audioListener(arr);
    } catch (_) {
      /* 忽略 */
    }
  };

  /**
   * 媒体事件泵。payload 形态对齐官方：
   *   { op:"properties", title, artist, album, albumArtist }
   *   { op:"thumbnail", thumbnail, primaryColor, textColor, ... }
   *   { op:"playback", state }  // 0/1/2
   *   { op:"timeline", position, duration }
   *   { op:"status", enabled }
   */
  w.__wePushMedia = function (payload) {
    if (!payload || typeof payload !== "object") return;
    var op = payload.op;
    if (op === "properties") {
      lastMedia.properties = payload;
      safeCall(mediaListeners.properties, payload);
    } else if (op === "thumbnail") {
      lastMedia.thumbnail = payload;
      safeCall(mediaListeners.thumbnail, payload);
    } else if (op === "playback") {
      lastMedia.playback = payload;
      safeCall(mediaListeners.playback, payload);
    } else if (op === "timeline") {
      lastMedia.timeline = payload;
      safeCall(mediaListeners.timeline, payload);
    } else if (op === "status") {
      lastMedia.status = payload;
      safeCall(mediaListeners.status, payload);
    }
  };

  /** 目录文件列表（首次或追加）。files: string[] */
  w.__wePushDirectoryFiles = function (propertyName, files) {
    var prop = String(propertyName || "");
    if (!prop || !Array.isArray(files)) return;
    var cleaned = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i] != null && String(files[i]) !== "") cleaned.push(String(files[i]));
    }
    if (!directoryFiles[prop]) directoryFiles[prop] = [];
    // 首次全量替换语义由调用方决定；这里 concat 去重
    var seen = Object.create(null);
    for (var j = 0; j < directoryFiles[prop].length; j++) seen[directoryFiles[prop][j]] = 1;
    var added = [];
    for (var k = 0; k < cleaned.length; k++) {
      if (!seen[cleaned[k]]) {
        seen[cleaned[k]] = 1;
        directoryFiles[prop].push(cleaned[k]);
        added.push(cleaned[k]);
      }
    }
    if (added.length) callDirectoryAdded(prop, added);
  };

  w.__weRemoveDirectoryFiles = function (propertyName, files) {
    var prop = String(propertyName || "");
    if (!prop || !Array.isArray(files) || !directoryFiles[prop]) return;
    var removeSet = Object.create(null);
    for (var i = 0; i < files.length; i++) removeSet[String(files[i])] = 1;
    var kept = [];
    var removed = [];
    for (var j = 0; j < directoryFiles[prop].length; j++) {
      var f = directoryFiles[prop][j];
      if (removeSet[f]) removed.push(f);
      else kept.push(f);
    }
    directoryFiles[prop] = kept;
    if (removed.length) callDirectoryRemoved(prop, removed);
  };

  // —— 外部指针注入（桌面 underlay 层收不到鼠标事件，父页经 __wp.pushPointer 推入）——
  //
  // 场景壁纸那条通道是「写一个状态对象、渲染器每帧读」（render/pointer.js）；网页壁纸
  // 没有这样的单一消费点 —— 作者代码就是**监听 DOM 事件**的，所以这里必须把推送
  // 还原成一串合成事件。语料（本机 49 张 web）：mousemove 24 张、click 29 张、
  // mouseover/out 17 张、mouseenter/leave 8 张、pointer* 16 张（createjs 系一律走
  // pointerdown/move/up）、.button 18 张、.which 17 张、pointerId/relatedTarget 15 张。
  //
  // 三条要点（都有语料依据，改错了会静默失效）：
  //
  //   1. **必须 elementFromPoint 按命中元素派发**，不能一律打 document。作者既有挂
  //      document/window 的（15 张，靠冒泡收到），也有挂 canvas 上读 `event.offsetX`
  //      的（1748506393 流体 `pointers[0].dx = (e.offsetX - …)`）。offsetX/offsetY 由
  //      浏览器按 target 的 padding box 现算 —— target 打错就是错的偏移，且无任何报错。
  //      pageX/pageY 同理由 clientX + 滚动量现算，不用我们填。
  //
  //   2. **over/out/enter/leave 链要按 W3C 语义补全**。1748506393 靠 canvas 的
  //      `mouseenter` 把 `pointers[0].down` 置 true（不进这个分支则鼠标怎么动都不出染料）、
  //      靠 window 的 `mouseleave` 复位；1081733658 animatedGrid 靠 `document.body` 的
  //      mouseover/mouseleave 起停整个网格动画。leave/enter 不冒泡，必须自己沿祖先链走到
  //      最近公共祖先，只发生变化的那一段。
  //
  //   3. **click 要靠 down/up 边缘合成**，且 down 与 up 的 target 不同（拖拽）时不发。
  //      29 张听 click 是最大的消费方；轮询推送里没有「点击」这个事件，只有按键掩码的
  //      跳变，边缘丢了就等于整类交互消失。
  //
  // 硬限制（写在这里避免反复试）：CSS `:hover` 由浏览器自己的 hit-test 驱动，合成事件
  // 永远点不亮它（18 张含 `:hover`）—— 纯 CSS hover 动画的壁纸无法用注入通道响应，
  // 这不是实现缺陷，是合成事件的固有边界。
  var ptrHas = false; // 是否收到过推送（首帧 movement 归零用）
  var ptrX = 0;
  var ptrY = 0;
  var ptrButtons = 0;
  var ptrTarget = null; // 上次命中元素（over/out 链的旧端）
  var ptrDownTarget = null; // 按下时的命中元素（click 判定）
  var ptrLastClickTime = 0;
  var ptrLastClickTarget = null;
  /** 双击判定窗口（ms）。与主流浏览器一致，语料里 5 张听 dblclick。 */
  var PTR_DBLCLICK_MS = 500;

  function ptrRoot() {
    try {
      return w.document.body || w.document.documentElement || null;
    } catch (_) {
      return null;
    }
  }

  function ptrHitTest(x, y) {
    try {
      if (typeof w.document.elementFromPoint === "function") {
        var el = w.document.elementFromPoint(x, y);
        if (el) return el;
      }
    } catch (_) {
      /* 忽略 */
    }
    return ptrRoot();
  }

  /** node → [node, parent, …, root]；用 parentNode 而非 parentElement，
   *  这样 document / documentElement 也在链里（作者挂 document 的 leave 要收到）。 */
  function ptrChain(node) {
    var out = [];
    var n = node;
    while (n) {
      out.push(n);
      try {
        n = n.parentNode || null;
      } catch (_) {
        n = null;
      }
    }
    return out;
  }

  function ptrCommonAncestor(a, b) {
    if (!a || !b) return null;
    var ca = ptrChain(a);
    var seen = [];
    for (var i = 0; i < ca.length; i++) seen.push(ca[i]);
    var cb = ptrChain(b);
    for (var j = 0; j < cb.length; j++) {
      for (var k = 0; k < seen.length; k++) {
        if (seen[k] === cb[j]) return cb[j];
      }
    }
    return null;
  }

  /**
   * 造一个合成鼠标/指针事件。
   *
   * `PointerEvent` 优先：createjs 一族（语料 7 张）只挂 pointerdown/move/up，
   * 且会读 `pointerId` / `pointerType` / `isPrimary`。环境没有 PointerEvent 时
   * 退回 MouseEvent（事件名照旧，作者的 addEventListener('pointermove') 仍能收到）。
   */
  function ptrMakeEvent(type, x, y, opts) {
    var o = opts || {};
    var isPointer = type.indexOf("pointer") === 0;
    var init = {
      bubbles: o.bubbles !== false,
      cancelable: o.cancelable !== false,
      // composed：作者把 canvas 放进 shadow DOM 时事件要能穿出来
      composed: true,
      view: w,
      detail: o.detail || 0,
      clientX: x,
      clientY: y,
      // screenX/screenY 是 init 字段（不像 pageX/offsetX 那样现算）。iframe 里
      // 只能按外层窗口原点近似；16 张读 screenX，多用于算相对位移而非绝对定位。
      screenX: x + (Number(w.screenX) || 0),
      screenY: y + (Number(w.screenY) || 0),
      // button：0 左 / 1 中 / 2 右（DOM 语义）。buttons 是位掩码，bit0 左。
      button: o.button || 0,
      buttons: o.buttons != null ? o.buttons : ptrButtons,
      movementX: o.movementX || 0,
      movementY: o.movementY || 0,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
    };
    if ("relatedTarget" in o) init.relatedTarget = o.relatedTarget || null;
    if (isPointer) {
      init.pointerId = 1;
      init.pointerType = "mouse";
      init.isPrimary = true;
      init.width = 1;
      init.height = 1;
      init.pressure = init.buttons ? 0.5 : 0;
      try {
        if (typeof w.PointerEvent === "function") return new w.PointerEvent(type, init);
      } catch (_) {
        /* 退回 MouseEvent */
      }
    }
    try {
      if (typeof w.MouseEvent === "function") return new w.MouseEvent(type, init);
    } catch (_) {
      /* 忽略 */
    }
    return null;
  }

  function ptrDispatch(node, type, x, y, opts) {
    if (!node || typeof node.dispatchEvent !== "function") return;
    var ev = ptrMakeEvent(type, x, y, opts);
    if (!ev) return;
    try {
      node.dispatchEvent(ev);
    } catch (_) {
      /* 作者处理器抛错不打断后续事件（与官方 CEF 一致：一个坏 listener 不该
         让整条链断掉，否则 leave 发不出去会留下永久 hover/按下态） */
    }
  }

  /** 命中元素变化时补 out/leave + over/enter 四段，顺序与浏览器一致。 */
  function ptrCrossBoundary(prev, next, x, y) {
    if (prev === next) return;
    var ancestor = ptrCommonAncestor(prev, next);
    if (prev) {
      ptrDispatch(prev, "pointerout", x, y, { relatedTarget: next });
      ptrDispatch(prev, "mouseout", x, y, { relatedTarget: next });
      var leaving = ptrChain(prev);
      for (var i = 0; i < leaving.length; i++) {
        if (leaving[i] === ancestor) break;
        // leave 不冒泡：必须逐个发，且 target 就是它自己
        ptrDispatch(leaving[i], "pointerleave", x, y, {
          bubbles: false,
          cancelable: false,
          relatedTarget: next,
        });
        ptrDispatch(leaving[i], "mouseleave", x, y, {
          bubbles: false,
          cancelable: false,
          relatedTarget: next,
        });
      }
    }
    if (next) {
      ptrDispatch(next, "pointerover", x, y, { relatedTarget: prev });
      ptrDispatch(next, "mouseover", x, y, { relatedTarget: prev });
      var entering = [];
      var chain = ptrChain(next);
      for (var j = 0; j < chain.length; j++) {
        if (chain[j] === ancestor) break;
        entering.push(chain[j]);
      }
      // enter 由外向内（祖先先收到），与浏览器一致
      for (var k = entering.length - 1; k >= 0; k--) {
        ptrDispatch(entering[k], "pointerenter", x, y, {
          bubbles: false,
          cancelable: false,
          relatedTarget: prev,
        });
        ptrDispatch(entering[k], "mouseenter", x, y, {
          bubbles: false,
          cancelable: false,
          relatedTarget: prev,
        });
      }
    }
  }

  /**
   * 外部指针注入入口。
   *
   * @param {number} x 相对 iframe 视口左边的 **CSS 像素**（= clientX 空间）
   * @param {number} y 同上，相对上边，Y 朝下
   * @param {number} [buttons] 按键位掩码，bit0 左键。与场景通道同一约定，
   *   当前只消费 bit0（右/中键位保留；桌面右键属于 Finder，不该被壁纸劫持）
   *
   * 接**像素**而不是归一化坐标：网页壁纸的 iframe 在 cover 露底自适配下可能比舞台大
   * 并带居中偏移（见 web.ts installLetterboxFix），换算需要 iframe 的几何 —— 那是父页
   * 才知道的信息，父页换算完再推进来，shim 不做二次除法。
   *
   * 暂停期间丢弃：官方暂停语义是「冻结渲染进程」，此时派发事件会让作者的动画状态
   * 在冻结中继续推进，恢复时画面跳一下。
   */
  w.__wePushPointer = function (x, y, buttons) {
    if (paused) return;
    var nx = Number(x);
    var ny = Number(y);
    // 非有限值直接丢弃（与场景通道同一约定）：NaN 传进 clientX 会让 elementFromPoint
    // 返回 null、后续 offsetX 全成 NaN，作者的位移积分会一次性污染成 NaN 且不报错。
    if (!isFinite(nx) || !isFinite(ny)) return;
    var mask = Number(buttons) || 0;
    var moved = !ptrHas || nx !== ptrX || ny !== ptrY;
    var maskChanged = mask !== ptrButtons;
    // 位置与按键都没变就什么都不发：宿主按 ~90Hz 推送，静止时重复派发
    // mousemove 会让作者的「有没有在动」判定（1081733658 网格）永远认为在动。
    if (!moved && !maskChanged) return;

    var dx = ptrHas ? nx - ptrX : 0;
    var dy = ptrHas ? ny - ptrY : 0;
    ptrX = nx;
    ptrY = ny;
    ptrHas = true;

    var target = ptrHitTest(nx, ny);
    if (moved) {
      ptrCrossBoundary(ptrTarget, target, nx, ny);
      ptrTarget = target;
      ptrDispatch(target, "pointermove", nx, ny, { movementX: dx, movementY: dy });
      ptrDispatch(target, "mousemove", nx, ny, { movementX: dx, movementY: dy });
    } else {
      ptrTarget = target;
    }

    if (!maskChanged) return;
    var wasDown = (ptrButtons & 1) !== 0;
    var isDown = (mask & 1) !== 0;
    ptrButtons = mask;
    if (isDown === wasDown) return; // 只有高位变化：当前不消费
    if (isDown) {
      ptrDownTarget = target;
      ptrDispatch(target, "pointerdown", nx, ny, { button: 0, detail: 1 });
      ptrDispatch(target, "mousedown", nx, ny, { button: 0, detail: 1 });
      return;
    }
    ptrDispatch(target, "pointerup", nx, ny, { button: 0, detail: 1 });
    ptrDispatch(target, "mouseup", nx, ny, { button: 0, detail: 1 });
    // click 只在 down/up 落在同一元素上时发（否则是拖拽，浏览器也不发）
    if (ptrDownTarget && ptrDownTarget === target) {
      var now = Date.now();
      var isDouble =
        ptrLastClickTarget === target && now - ptrLastClickTime <= PTR_DBLCLICK_MS;
      ptrDispatch(target, "click", nx, ny, { button: 0, detail: isDouble ? 2 : 1 });
      if (isDouble) {
        ptrDispatch(target, "dblclick", nx, ny, { button: 0, detail: 2 });
        ptrLastClickTarget = null;
        ptrLastClickTime = 0;
      } else {
        ptrLastClickTarget = target;
        ptrLastClickTime = now;
      }
    }
    ptrDownTarget = null;
  };

  /**
   * 指针离开本窗口（鼠标去了别的显示器）。
   *
   * 与场景通道不同，这里**必须把 out/leave 链发出去**：场景侧只是清一个状态位，
   * 而网页作者的 hover 态是自己记的，不发 leave 就永久卡在「鼠标还在上面」
   * （1081733658 网格会一直跑、1748506393 的 `pointers[0].down` 一直为 true）。
   * 按下态也要补一次 up，否则拖拽逻辑永远不结束。
   */
  w.__wePointerLeave = function () {
    if ((ptrButtons & 1) !== 0 && ptrTarget) {
      ptrDispatch(ptrTarget, "pointerup", ptrX, ptrY, { button: 0, buttons: 0, detail: 1 });
      ptrDispatch(ptrTarget, "mouseup", ptrX, ptrY, { button: 0, buttons: 0, detail: 1 });
    }
    ptrButtons = 0;
    ptrDownTarget = null;
    if (ptrTarget) {
      ptrCrossBoundary(ptrTarget, null, ptrX, ptrY);
      ptrTarget = null;
    }
    // 位置（ptrX/ptrY）与 ptrHas 保留：下次进来时 movement 才是真实位移，
    // 而不是从 (0,0) 跳过来的一个巨大假 delta。
  };

  // —— rAF 节流（带 __weThrottled，避免父页 injectGpuThrottle 双层减半）——

  function installRafThrottle() {
    var throttled = function (cb) {
      if (typeof cb !== "function") return 0;
      if (paused) {
        var idHold = ++rafCounter;
        rafMap[idHold] = { kind: "hold", cb: cb };
        return idHold;
      }
      var limit = fps >= 60 ? 0 : 1000 / fps;
      if (limit <= 0) {
        var idNative = origRaf(function (now) {
          delete rafMap[idNative];
          try {
            cb(now);
          } catch (_) {
            /* 忽略 */
          }
          try {
            w.parent.postMessage({ op: "we-frame", t: now }, "*");
          } catch (_) {
            /* 忽略 */
          }
        });
        rafMap[idNative] = { kind: "native", id: idNative };
        return idNative;
      }
      var id = ++rafCounter;
      var to = w.setTimeout(function () {
        delete rafMap[id];
        origRaf(function (now) {
          try {
            cb(now);
          } catch (_) {
            /* 忽略 */
          }
          try {
            w.parent.postMessage({ op: "we-frame", t: now }, "*");
          } catch (_) {
            /* 忽略 */
          }
        });
      }, limit);
      rafMap[id] = { kind: "timeout", to: to };
      return id;
    };
    throttled.__weThrottled = true;
    w.requestAnimationFrame = throttled;
    w.cancelAnimationFrame = function (id) {
      var ent = rafMap[id];
      if (!ent) {
        try {
          origCaf(id);
        } catch (_) {
          /* 忽略 */
        }
        return;
      }
      delete rafMap[id];
      if (ent.kind === "timeout") w.clearTimeout(ent.to);
      else if (ent.kind === "native") origCaf(ent.id);
    };
  }

  installRafThrottle();
})(window);

