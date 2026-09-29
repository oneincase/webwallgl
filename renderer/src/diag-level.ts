// 诊断级别的判定与上报 URL —— 纯函数，无 DOM/无依赖。
//
// verify-diag.mjs 直接 Node import 本文件（Node ≥ 22.6 默认剥离类型）跑真现，
// 所以这里**不许**出现顶层 DOM 求值、也不许 import 运行时模块（类型导入除外，
// `import type` 运行时整体擦除）。
import type { DiagnosticLevel } from "./api/types";

/**
 * 兜底判据 —— 只用于**没声明级别**的上报（外部透传文案：`[we-scene]` 桥、
 * 效果链解析回调、动画联动回调、渲染器 diag 钩子）。
 *
 * 本仓库自己的 reportDiag 调用**一律显式声明级别**（reportDiag 第 4 参），
 * 因为纯文本判据原理上就判不对 —— issue #13 的反例里，`bake: 后台补烘完成 0 张
 * （失败 0，…）` 的级别取决于 `failed` 的**数值**：0 = 正常完成（info），
 * >0 = 有补烘没做成（warn）。同一行文案两种级别，只有上报方知道。
 *
 * 两处收紧（issue #13 建议 4）：
 *   - **零计数豁免**：`失败 0` / `失败: 0` / `glErr=0` 这类「失败计数 = 0」不是失败，
 *     而是正常完成（`bake: …（失败 0，…）`、`bloom frame … glErr=0 …` 都是统计行）；
 *   - `ERR` / `FAIL` 词首匹配 —— `TERRAIN`、`FAILSAFE` 这类名字不许误命中。
 *
 * 三档语义（与 api/types.ts 的 DiagnosticLevel 同一份）：
 *   - error：壁纸挂不上或已经死了，**需要调用方介入**（挂载失败、渲染循环终止、
 *     首帧超时、宿主/环境缺位到挂不上）
 *   - warn：画面受影响或有损降级，壁纸仍在跑（脚本没跑起来、资源缺失/解码失败、
 *     效果与贴图回退或跳过、裁切溢出、降档限速）
 *   - info：过程与统计
 *
 * 兜底判据偏保守：外部文案判不出「需要调用方介入」，只有明确的终局措辞才给
 * error，其余带失败意味的一律 warn —— 宁可少报严重级别，也不把统计行打成故障。
 */
export function classifyDiag(msg: string): DiagnosticLevel {
  const t = String(msg ?? "");
  if (!t) return "info";

  // 「失败 0」/「失败: 0」/「失败：0 张」/「glErr=0」= 零计数：把整条计数连词一起
  // 掩掉，否则下面的失败网照样命中 `失败` 两个字（issue #13 的假阳性就是这么来的）。
  const masked = t.replace(/(失败|FAIL|glErr)(\s*[:：=]?\s*)0(?![.\d])/gi, "零计数$2");

  // 终局措辞：挂不上 / 已经死了 / 环境缺位到挂不上 —— 调用方必须介入。
  if (
    /(^|[:：\s])(failed|fatal)([:：\s]|$)/i.test(t) ||
    /(渲染循环终止|首帧超时|挂载失败|上下文丢失|context lost|WEBGL2_UNAVAILABLE|无可用容器|缺少 src|缺少资源 URL)/.test(t)
  ) {
    return "error";
  }

  // 失败/降级/跳过一类：画面受影响或有损继续，壁纸仍在跑。
  if (
    /(失败|出错|抛错)/.test(masked) ||
    /(?<![A-Za-z])(ERR|ERROR|FAIL)(?![A-Za-z])/i.test(masked) ||
    /(glErr|跳过|回退|回落|退回|降级|降档|不可用|缺失|缺 shader|裁切|溢出|悬空|不完整|不支持|fallback|黑屏|封顶|拒绝|自愈|忽略|静默|兜底|改用|沿用|退化)/.test(masked)
  ) {
    return "warn";
  }
  return "info";
}

/** 级别归一：上报方声明优先，缺省/非法值才回落文本判据。 */
export function diagLevelOf(msg: string, level?: DiagnosticLevel): DiagnosticLevel {
  return level === "error" || level === "warn" || level === "info" ? level : classifyDiag(msg);
}

/**
 * `/diag` 像素请求的 URL（`<img>` 免 CORS，宿主中间件收下打日志）。
 *
 * 带 `lvl=<level>` —— 级别由**发送端声明**并随请求一起发出去，嵌入方不必再对
 * 文案做关键字匹配（issue #13）。`msg` 仍在原位，老消费方不受影响。
 */
export function diagUrl(origin: string, src: string | undefined, msg: string, level: DiagnosticLevel): string {
  const text = `scene ${src ?? "?"}: ${String(msg ?? "").slice(0, 500)}`;
  return `${origin}/diag?msg=${encodeURIComponent(text)}&lvl=${level}`;
}
