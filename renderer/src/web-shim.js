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
      afterAssign(function () {
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
  w.__weSetPaused = function (v) {
    var next = !!v;
    if (next === paused) return;
    paused = next;
    callSetPaused(paused);
    if (!paused) resumeTimers();
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

