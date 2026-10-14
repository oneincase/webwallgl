// 已写出内容指纹：**每个项目目录各一份**（task-22）。
//
// 为什么不能是一张按路径记的全局表：换工程文件夹时 `adoptProject()` 会清表，但**上一轮 flush
// 可能还卡在 `writeToDirectory` 的 await 里** —— 它醒来后的记账（`for (const f of changed) …set`）
// 发生在清表之后，于是「写进旧目录的指纹」被算到新目录头上：新目录这一轮 `changed=[]`，一个字节
// 都不写，而它同时把 `dirty` 置回 false（之后不再有 flush）。真机现场就是「切到新文件夹后盘上只剩
// .webwallgl-editor、页面却显示已保存（保存用时 0.0s、0 条保存失败）」。
// 按目录分开记之后，旧一轮的记账落在它自己的表里，不再影响新目录；只清一份也不会动到另一份。

/** 目录 → 该目录的「已写出内容指纹」。键是目录句柄对象，句柄被回收时这张表自然消失。 */
const byDir = new WeakMap<object, Map<string, string>>();

/** 取该目录的指纹表（没有就建一张）。记与读必须都走这里，别在别处另存一份。 */
export function sigFor(dir: object): Map<string, string> {
  let sig = byDir.get(dir);
  if (!sig) {
    sig = new Map();
    byDir.set(dir, sig);
  }
  return sig;
}

/** 内容签名：长度 + FNV-1a 32 位。没变的文件跳过重写，变了（含只改长度）才写。 */
export function fileSig(data: Uint8Array): string {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 16777619);
  return `${data.length}:${h >>> 0}`;
}
