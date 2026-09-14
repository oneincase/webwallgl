// WE SceneScript 的 localStorage 语义（ILocalStorage）。
//
// 官方文档（docs.wallpaperengine.io）：
//   - **按壁纸共享**：同一张壁纸的全部脚本（文字/对象字段/效果开关/常量/general，
//     五 eval 点）看到同一份存储；不是每个脚本一份。
//   - **跨会话持久**：默认位置 LOCATION_SCREEN 的数据落盘，重挂/重启后仍在。
//   - 全局位置 LOCATION_GLOBAL：跨壁纸共享（作者用它做「所有壁纸统一次数」）。
//   - 容量约 100KB。
//   - API 是 getItem/setItem/removeItem/clear/key/length；WE 文档方法名是
//     `delete`（不是 removeItem），语料里 `localStorage.set/get/remove` 非标准
//     别名也都出现过，一并提供。
//
// 引擎侧零 DOM、零 IO：所有读写经注入的 provider（{get,set,remove,clear,keys}）。
// provider 缺失时退化为进程内 Map（离线 verifier / 未接持久化的宿主用）。
// 纯逻辑模块，Node 可直载（ARCHITECTURE §三不变量）。

/** 位置常量：暴露给脚本做 localStorage.clear(location) 等参数 */
export const LOCATION_SCREEN = 0
export const LOCATION_GLOBAL = 1

/**
 * 造一份沙箱 localStorage。
 * @param {object|null|undefined} screenProvider  LOCATION_SCREEN（按壁纸）的持久后端
 * @param {object|null|undefined} globalProvider  LOCATION_GLOBAL（跨壁纸）的持久后端
 *
 * provider 契约（全部同步；WE 的 localStorage 就是同步 API）：
 *   get(key) -> string|null
 *   set(key, value)
 *   remove(key)
 *   keys() -> string[]
 *   clear()
 * 任一方法缺失该 provider 视为未提供。
 */
export function makeSandboxStorage(screenProvider, globalProvider) {
  const mem = new Map()
  const screen = normalizeProvider(screenProvider) || memProvider(mem)
  const global = normalizeProvider(globalProvider) || null

  // 选后端：LOCATION_GLOBAL 且有全局后端才走全局；其余（含非法值）一律 screen。
  const backendFor = (location) =>
    location === LOCATION_GLOBAL && global ? global : screen

  const api = {
    LOCATION_SCREEN,
    LOCATION_GLOBAL,
    getItem(key, location = LOCATION_SCREEN) {
      return backendFor(location).get(String(key))
    },
    setItem(key, value, location = LOCATION_SCREEN) {
      backendFor(location).set(String(key), String(value))
    },
    // WE 文档名是 delete（保留字，脚本里只能 localStorage.delete(k) 成员调用，
    // 合法）；DOM 名 removeItem 与语料别名 remove 都给。
    delete(key, location = LOCATION_SCREEN) {
      backendFor(location).remove(String(key))
    },
    removeItem(key, location = LOCATION_SCREEN) {
      backendFor(location).remove(String(key))
    },
    clear(location = LOCATION_SCREEN) {
      backendFor(location).clear()
    },
    key(index, location = LOCATION_SCREEN) {
      const keys = backendFor(location).keys()
      return index >= 0 && index < keys.length ? keys[index] : null
    },
  }
  // 语料非标准别名（3238423642 等按 localStorage.set/get 调用）
  api.get = api.getItem
  api.set = api.setItem
  api.remove = api.delete
  Object.defineProperties(api, {
    // length 只反映默认（screen）位置；脚本极少带参读它。
    length: {
      enumerable: false,
      get() {
        return screen.keys().length
      },
    },
  })
  return api
}

function normalizeProvider(p) {
  if (!p || typeof p !== 'object') return null
  if (typeof p.get === 'function' && typeof p.set === 'function' &&
      typeof p.remove === 'function' && typeof p.keys === 'function' &&
      typeof p.clear === 'function') {
    return p
  }
  return null
}

function memProvider(m) {
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)) },
    remove: (k) => { m.delete(k) },
    keys: () => Array.from(m.keys()),
    clear: () => { m.clear() },
  }
}
