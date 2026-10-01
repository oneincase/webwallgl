// 源码级判据的共用工具：**字符串感知**地剥掉注释。
//
// 为什么不能用朴素正则：`/\*[\s\S]*?\*\//` 会把**字符串里的 `/*`** 当成块注释开头，
// 一路吃到后面某个 `*/` —— 于是「剥注释」反而删掉了真代码。本轮实测踩到：
// scene-mount.ts 里刚插入的一段（`thisMdl.dispose?.()`）被吞掉，守卫假红。
//
// 同一族坑的另外两次（都记在 docs/ENGINE-REVIEW-2026-10.md §10）：
//   · 注入脚本用模板字面量承载时 `\/` 被折成 `/`，把正则拆成语法错误；
//   · 守卫的正则里带注释文本，而 stripComments 恰好把那句注释剥了。
// 所以：**判据的取词方式本身也要有判据**。
//
// 正则字面量识别：不处理的话，`/['"]/` 里的引号会翻转引号状态 —— 之后的注释就不再被
// 剥掉，守卫会把**注释里的**禁词当成代码判红（本轮实测：renderer.js 的 HDR 分支注释
// 里写着「这里原来是 msaaTarget = null」，直接假红）。用通行的前导字符启发式：
// `/` 前若是运算符/开括号/逗号/关键字一类的「期望表达式」位置，就按正则字面量扫描。
//
// 剩下不处理的：注释与正则的各种极端写法。宁可假红（会被人看到）也不要静默漏判。

/** `/` 之前是否处于「期望表达式」位置（决定 `/` 是除号还是正则起始） */
function regexAllowed(prevSignificant) {
  if (prevSignificant === "") return true;
  return "([{,;:!&|?+-*/%<>^~=".includes(prevSignificant);
}

/** 剥掉行注释与块注释，保留字符串/模板字面量内容 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = null; // 当前所在引号：' " `
  let prev = ""; // 上一个非空白字符（判正则用）
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (quote) {
      out += c;
      if (c === "\\") {
        out += src[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      prev = c;
      i++;
      continue;
    }
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed(prev)) {
      // 正则字面量：整体搬运（含字符类里的 / 与转义）
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        const d = src[j];
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        else if (d === "\n") break; // 不是正则，退化为除号
        j++;
      }
      if (j < n && src[j] === "/") {
        out += src.slice(i, j + 1);
        i = j + 1;
        while (i < n && /[a-z]/i.test(src[i])) {
          out += src[i];
          i++;
        }
        prev = ")";
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}
