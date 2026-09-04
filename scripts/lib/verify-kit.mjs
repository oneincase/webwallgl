/**
 * verify-kit —— 全部 verify-*.mjs 共用的离线校验基础设施。
 *
 * 只收纳各脚本**逐字同构**的样板：
 *   - ROOT / LIB 路径解析（此前 8+ 份各抄一遍，且 resolve/join 写法不一致）；
 *   - imp(rel)：以 file:// 动态导入 vendor 模块（vendor 是带显式 .js 的原生 ESM，
 *     Node 与浏览器加载同一条路径，这是离线校验能存在的前提）；
 *   - createChecker()：断言收集器。此前各脚本手写 `const errors = []`，
 *     收集行为略有出入（有的立即打印、有的只攒着）——用 echo 选项归一。
 *
 * 刻意**不**收纳领域 helper（num / readJson / 曲线复算等）：它们在各脚本里
 * 语义有微差（如 num 对 {user,value} 解包与布尔映射），合并等于改判据。
 *
 * 用法：
 *   import { ROOT, LIB, imp, createChecker, dec } from "./lib/verify-kit.mjs";
 *   const { check, fail, errors } = createChecker();
 *   // ……脚本自身的判据与汇总输出保持不变……
 */
import fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根（scripts/lib/ 的上两级） */
export const ROOT = resolve(here, "..", "..");

/** 壁纸素材库目录：WE_LIBRARY 覆盖，否则 macOS 应用默认路径（仅本地存在，不入库） */
export const LIB = process.env.WE_LIBRARY
  ? resolve(process.env.WE_LIBRARY)
  : join(
      process.env.HOME ?? "",
      "Library/Application Support/io.github.oneincase.wallpaperem/wallpapers",
    );

/** 动态导入仓库内相对路径模块（绕开 Node 对裸相对路径 ESM 的限制） */
export const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);

/** 壁纸库内某 item 的目录 */
export const itemDir = (itemId) => join(LIB, String(itemId));

/** 判据收集器。echo=true 时断言失败的瞬间就打印（verify-pointer 风格），默认只攒。 */
export function createChecker({ echo = false } = {}) {
  const errors = [];
  const check = (cond, msg) => {
    if (!cond) {
      errors.push(msg);
      if (echo) console.log("  ✗ " + msg);
    }
  };
  const fail = (msg) => check(false, msg);
  return { check, fail, errors };
}

/** 共享 TextDecoder（各脚本此前各自 new 一个） */
export const dec = new TextDecoder();

/** 读取壁纸库内 item 的任意文件；不存在返回 null */
export function readItemFile(itemId, ...rel) {
  const p = join(itemDir(itemId), ...rel);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

/** 解析 item 的 project.json；缺失/损坏返回 null */
export function readProjectJson(itemId) {
  const b = readItemFile(itemId, "project.json");
  if (!b) return null;
  try {
    return JSON.parse(dec.decode(b));
  } catch {
    return null;
  }
}
