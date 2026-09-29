#!/usr/bin/env node
/**
 * verify-diag —— 诊断**级别**契约（issue #13）。
 *
 * 三件事必须成真，缺一件就是那个 issue 的回归：
 *   1. 级别由**上报方声明**，且随请求一起发出去 —— `/diag?msg=…&lvl=<level>`。
 *      嵌入方不必再对文案做关键字匹配（issue #13 的诉求就是这条）。
 *   2. 三档语义稳定：error=挂不上/已死（调用方必须介入）、warn=画面受影响或有损
 *      降级（壁纸仍在跑）、info=过程与统计。同一个级别进 onDiagnostic 与 /diag。
 *   3. 文本判据只兜**外部透传文案**，且收紧两处：零计数豁免（`失败 0`/`glErr=0`
 *      不算失败）、`ERR`/`FAIL` 词首匹配（`TERRAIN`/`FAILSAFE` 不许误命中）。
 *
 * 判据跑的是**真现**：直接 Node import renderer/src/diag-level.ts（纯模块，无 DOM），
 * 不是脚本内复算副本 —— verify-camera 那条教训（副本与实现漂移）就是前车之鉴。
 * 调用点是否逐处声明级别，则扫源码断言（reportDiag 第 4 参必填，漏一处 tsc 就红）。
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const here = join(fileURLToPath(import.meta.url), '..')
const ROOT = join(here, '..')

let failed = 0
function check(ok, msg) {
  if (ok) console.log(`  ✓ ${msg}`)
  else { failed++; console.error(`  ✗ ${msg}`) }
}

// 真现：Node ≥ 22.6 默认剥离 .ts 的类型；老 Node 重跑一次打开开关。
const dlUrl = pathToFileURL(join(ROOT, 'renderer/src/diag-level.ts')).href
let DL
try {
  DL = await import(dlUrl)
} catch (e) {
  if (!/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION/.test(String(e))) throw e
  const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(r.status ?? 1)
}
const { classifyDiag, diagLevelOf, diagUrl } = DL

const read = (rel) => fs.readFileSync(join(ROOT, rel), 'utf8')

/**
 * reportDiag 的第 4 参（级别）。取**最后一个顶层逗号**之后那段：级别表达式本身
 * 不含逗号（`"info"` / `classifyDiag(m)` / `bakeStats.failed > 0 ? "warn" : "info"`），
 * 而消息文案里带逗号是常事（`stream, supportsaudioprocessing=…`）——按第 3、4 个
 * 逗号切会被文案带偏，那正是本判据要锁的东西，不能自己先不准。
 */
function levelOf(args) {
  const trimmed = args.replace(/,\s*$/, '')
  let d = 0, last = -1
  for (let k = 0; k < trimmed.length; k++) {
    const ch = trimmed[k]
    if ('([{'.includes(ch)) d++
    else if (')]}'.includes(ch)) d--
    else if (ch === ',' && d === 0) last = k
  }
  return trimmed.slice(last + 1).trim()
}

/** 源码里所有 reportDiag 调用点：{line, args, level}，level 为第 4 参原文 */
function callSites(rel) {
  const src = read(rel)
  const out = []
  for (const m of src.matchAll(/\breportDiag\(/g)) {
    let i = m.index + m[0].length, depth = 1, j = i
    while (depth > 0 && j < src.length) {
      if (src[j] === '(') depth++
      else if (src[j] === ')') depth--
      j++
    }
    const args = src.slice(i, j - 1)
    out.push({
      line: src.slice(0, m.index).split('\n').length,
      args,
      level: levelOf(args),
    })
  }
  return out
}

const shellSrc = read('renderer/src/shell.ts')
const typesSrc = read('renderer/src/api/types.ts')

console.log('\n[1] issue #13 的三条反例：级别不再靠文案猜')
{
  // ① 文案里「失败」出现在**计数 = 0** 的语境里，语义相反 —— 文本判据原理上判不对，
  //    只有上报方知道（scene-mount 的 bake 补烘回调就是按 bakeStats.failed 数值定档）。
  check(classifyDiag('bake: 后台补烘完成 0 张（失败 0，产物 0.0MB，耗时 0ms）') === 'info',
    '「失败 0」的正常完成行是 info（不是 error）—— issue #13 假阳性')
  check(classifyDiag('bake: 后台补烘完成 3 张（失败 2，产物 1.2MB，耗时 40ms）') === 'warn',
    '「失败 2」的真失败行是 warn（计数 > 0 才算失败）')
  // ② 「画面受影响」不等于「宿主级故障」：脚本没跑起来是 warn。
  check(classifyDiag("object script 'VHS Time and Date.origin' 失败: Unexpected token 'export'") === 'warn',
    '脚本失败是 warn（画面受影响，壁纸仍在跑）—— issue #13 表格第 1 行')
  // ③ 降级措辞必须收进 warn：老网 `/fail|error|失败|ERROR/` 收不到「不可用」「fallback」。
  check(classifyDiag('liveSystem: 系统音频不可用（none），网页壁纸沿用模拟源') === 'warn',
    '「不可用…沿用模拟源」是 warn —— issue #13 假阴性')
  check(classifyDiag('网页壁纸 shim 注入失败（blocked），fallback to bare iframe') === 'warn',
    '「fallback to bare iframe」是 warn —— issue #13 假阴性')
}

console.log('\n[2] 收紧判据：零计数豁免 + ERR/FAIL 词首匹配')
{
  check(classifyDiag('补烘完成 0 张（失败 0）') === 'info', '「失败 0」（冒号/全角冒号变体）零计数豁免')
  check(classifyDiag('bloom frame 12: center=[0.1] glErr=0 threshold=0.5') === 'info', '「glErr=0」统计行是 info')
  check(classifyDiag('msaa resolve: glErr=1282') === 'warn', '「glErr=1282」是 warn（非零才报）')
  check(classifyDiag("tex 'TERRAIN_ATLAS': 2048x2048 declared=2048x2048") === 'info', 'TERRAIN 不被 ERR 词首规则误命中')
  check(classifyDiag("model 'FAILSAFE_BOX' v=12 static") === 'info', 'FAILSAFE 不被 FAIL 词首规则误命中')
  check(classifyDiag("video tex 'v' ERROR: 3") === 'warn', 'ERROR 词首命中 → warn')
  check(classifyDiag('video upload FAIL: boom') === 'warn', 'FAIL 词首命中 → warn')
  check(classifyDiag('particle advance error: boom') === 'warn', 'error 词首命中 → warn')
}

console.log('\n[3] 终局措辞才是 error（调用方必须介入）')
{
  check(classifyDiag('failed: renderLoop 异常，渲染循环终止 — TypeError: x') === 'error', '渲染循环终止 = error')
  check(classifyDiag('failed: mount 首帧超时 60000ms（渲染循环无首帧、无 onError）') === 'error', '首帧超时 = error')
  check(classifyDiag('media image: WEBGL2_UNAVAILABLE') === 'error', 'WEBGL2 不可用 = error')
  check(classifyDiag('网页壁纸：无可用容器') === 'error', '无可用容器 = error')
  check(classifyDiag('media video 失败: 解码/加载失败（code 4）') === 'warn', '资源解码失败 = warn（画面受影响）')
  check(classifyDiag("puppet 'x' 无贴图，跳过") === 'warn', '跳过 = warn')
  check(classifyDiag("tex 't': 512x512 declared=512x512 R=1") === 'info', '尺寸统计 = info')
}

console.log('\n[4] 声明优先：上报方的级别压过文案判据')
{
  check(diagLevelOf('tex t: 1x1', 'error') === 'error', '声明 error 时不被文案判据降级')
  check(diagLevelOf('failed: x', 'info') === 'info', '声明 info 时不被文案判据升级')
  check(diagLevelOf('失败 0', undefined) === 'info', '未声明才回落文本判据')
  check(diagLevelOf('失败 0', 'warn') === 'warn', '声明优先于零计数豁免（bake 失败 > 0 那条就是这么声明的）')
  check(diagLevelOf('x', 'bogus') === 'info', '非法级别值回落文本判据')
}

console.log('\n[5] /diag 请求把级别随请求发出去（issue #13 的诉求本体）')
{
  const u = new URL(diagUrl('http://127.0.0.1:1430', '2566558804', "object script 'x' 失败: boom", 'warn'))
  check(u.pathname === '/diag', 'URL 仍是 /diag 端点')
  check([...u.searchParams.keys()].join(',') === 'msg,lvl', `query 里 msg 与 lvl 都在（实得 ${[...u.searchParams.keys()].join(',')}）`)
  check(u.searchParams.get('lvl') === 'warn', 'lvl= 就是上报方声明的级别')
  check(u.searchParams.get('msg') === "scene 2566558804: object script 'x' 失败: boom", 'msg 文本与前缀不变（老消费方不受影响）')
  check(new URL(diagUrl('http://h', undefined, 'm', 'info')).searchParams.get('msg') === 'scene ?: m', 'src 缺省仍记为 "?"')
  const long = diagUrl('http://h', 's', 'x'.repeat(900), 'info')
  check(new URL(long).searchParams.get('msg').length === 'scene s: '.length + 500, 'msg 截断到 500 字符')
  check(diagUrl('http://h', 's', 'a&b=c', 'error').includes(encodeURIComponent('scene s: a&b=c')), '特殊字符走 encodeURIComponent')
  check(/&lvl=error$/.test(diagUrl('http://h', 's', 'm', 'error')), 'lvl 恒在末尾、值为字面量')
}

console.log('\n[6] 调用点逐处声明级别（级别由发送端声明，而不是事后猜）')
{
  const files = [
    'renderer/src/api/mount.ts',
    'renderer/src/media.ts',
    'renderer/src/scene-mount.ts',
    'renderer/src/web.ts',
    'renderer/src/shell.ts',
  ]
  let total = 0
  let missing = []
  for (const f of files) {
    for (const c of callSites(f)) {
      total++
      if (!c.level) missing.push(`${f}:${c.line}`)
    }
  }
  check(total >= 127, `扫到 ${total} 处 reportDiag（含定义处）`)
  check(missing.length === 0, `每处都带级别（缺 ${missing.length}：${missing.slice(0, 5).join(' ')}）`)
  // 取出的「级别」必须真是级别表达式：含反引号就说明取参取错了（消息里带逗号的
  // 调用若按第 3、4 个逗号切就会取到消息片段 —— levelOf 用最后一个顶层逗号避开）
  const weird = []
  for (const f of files) {
    for (const c of callSites(f)) {
      if (!c.level || /`/.test(c.level) || !/(?:info|warn|error|classifyDiag|DiagnosticLevel)/.test(c.level)) {
        weird.push(`${f}:${c.line} => ${c.level}`)
      }
    }
  }
  check(weird.length === 0, `每处的级别都是合法表达式（异常 ${weird.length}：${weird.slice(0, 3).join(' ')}）`)
  // reportDiag 的第 4 参必须是必填 —— 否则新写一处不传级别就静默回落文本判据
  check(/reportDiag\(\s*rt:\s*Runtime,\s*cfg:\s*WallpaperConfig,\s*msg:\s*string,\s*level:\s*DiagnosticLevel\s*\)/.test(shellSrc),
    'reportDiag 签名里 level 必填（DiagnosticLevel）')
}

console.log('\n[7] 两条通道同一个级别 + 老判据已下岗')
{
  check(/rt\.onDiagnostic\?\.\(msg,\s*lvl\)/.test(shellSrc), 'onDiagnostic 收到归一后的级别')
  check(/diagUrl\(origin,\s*cfg\.src,\s*msg,\s*lvl\)/.test(shellSrc), '/diag URL 用同一个级别拼出 lvl=')
  check(!/\/fail\|error\|失败\|ERROR\//.test(shellSrc), 'shell.ts 里老文本判据 /fail|error|失败|ERROR/ 已移除')
  check(/export type DiagnosticLevel = "info" \| "warn" \| "error"/.test(typesSrc), 'DiagnosticLevel 三档在 api/types.ts 固定下来')
  check(/onDiagnostic\?: \(msg: string, level: DiagnosticLevel\) => void/.test(shellSrc), 'onDiagnostic 的级别名固定为 DiagnosticLevel（issue #13 建议 3）')
}

console.log('\n[8] issue #13 点名的调用点，声明值就是它表格里想要的')
{
  /** 找到报「needle」这条文案的调用点，返回它的第 4 参 */
  const declared = (rel, needle) => {
    const hit = callSites(rel).find((c) => c.args.includes(needle))
    return hit ? hit.level : null
  }
  const want = (rel, needle, level) => {
    const got = declared(rel, needle)
    check(got === level, `「${needle.slice(0, 26)}…」声明为 ${level}（实得 ${got ?? '（找不到）'}）`)
  }
  want('renderer/src/scene-mount.ts', 'object script', '"warn"')
  want('renderer/src/scene-mount.ts', '后台补烘完成', 'bakeStats.failed > 0 ? "warn" : "info"')
  want('renderer/src/web.ts', 'shim 注入失败', '"warn"')
  want('renderer/src/web.ts', '系统音频不可用', '"warn"')
  want('renderer/src/scene-mount.ts', 'renderLoop 异常', '"error"')
  want('renderer/src/media.ts', 'WEBGL2_UNAVAILABLE', 'embedded ? "error" : "warn"')
  want('renderer/src/scene-mount.ts', '文字被画布裁切', '"warn"')
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
