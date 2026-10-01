// 固定种子 PRNG（mulberry32）—— 全引擎唯一一份实现
//
// 收敛依据（B1，docs/ENGINE-REVIEW-2026-10.md §5）：system-textures / particle-textures /
// pattern-textures 各自带一份**逐字相同**的拷贝（实测三份 263 字节全等），已摘线但保留
// 文件体的 noise.js 还有第四份（只差 `function ()` 与 `() =>`）。
//
// 为什么值得收敛：内置贴图是**按种子确定性程序化生成**的，任何一处常数/位移/取模被顺手改掉，
// 受影响的那类贴图就会整张变样 —— 而画面上往往只表现为「噪点分布不太一样」，眼睛对不出来。
// 四份拷贝并存时，「只改了一处」的风险就一直挂着。判据是 scripts/verify-rng.mjs 的
// 82 张内置贴图 + 种子表**像素金样**（改前采集，改后必须逐条相同）。
//
// 为什么这里提到「零依赖」不再成立：重复处的注释写的是「三份重复是既有的零依赖约定的代价」，
// 但那是**对外**零依赖 —— 引擎内部模块互相 import 早已是常态（particles ← particle-util 等），
// 本文件只是走同一套内部依赖，不引入任何外部依赖。

/**
 * mulberry32：32 位固定种子 PRNG，返回 [0,1) 取值的函数。序列由种子唯一决定，
 * 跨平台一致（只用 Math.imul / 位运算 / >>>0，无浮点累积）。
 */
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
