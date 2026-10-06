// 外来脚本执行策略（EDITOR-PLAN W10 过渡方案）。
// 场景脚本的沙箱不是安全边界（Function / eval 遮蔽不住），在线版与编辑器同源，打开别人的
// 壁纸就等于在本页执行它的代码。W10 拍板（Worker 化 or 接受风险）之前：
//   - dev 宿主（本机壁纸库可达）：与测试台一致，照常执行；
//   - 在线版（无宿主）：外来内容默认不执行，由用户逐个文档显式放行；
//   - 编辑器里新建的工程（含其草稿）是用户自己的内容，照常执行。
// `?scripts=off` 把本页当在线版对待（安全模式，也供端到端模拟），`?scripts=on` 反之。

export type ContentKind = "new" | "library" | "local";
export type ScriptsOverride = "on" | "off" | null;

export function scriptsOverrideFrom(search: string): ScriptsOverride {
  const v = new URLSearchParams(search).get("scripts");
  return v === "on" || v === "off" ? v : null;
}

/** 打开一份文档时脚本是否默认执行 */
export function scriptsAllowedByDefault(kind: ContentKind, hostAvailable: boolean, override: ScriptsOverride): boolean {
  if (kind === "new") return true;
  if (override) return override === "on";
  return hostAvailable;
}
