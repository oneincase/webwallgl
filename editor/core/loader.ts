// profile 装配：按配置把一组插件挂到根上下文。
//
// profile 只是数据（{ plugins: [{ name, config?, disabled? }] }），插件实体从 catalog 按名取；
// 换掉任一内置能力 = profile 里把它 disabled、再挂一个提供同名服务的插件。
// 依赖顺序不用手排：inject 自动等待。装配完 settle 后仍 pending 的插件列入 unresolved，
// 并区分「缺服务」与「依赖环」两种情形。

import type { Context, Plugin, Scope } from "./context";

export type ProfileEntry = { name: string; config?: unknown; disabled?: boolean };
export type Profile = { plugins: ProfileEntry[] };
export type Catalog = Record<string, Plugin<any>>;

export type Unresolved = { name: string; missing: string[]; cycle: boolean };

export type LoadResult = {
  scopes: Map<string, Scope>;
  unresolved: Unresolved[];
  unknown: string[];
};

/** 叠加 profile：后者同名条目覆盖前者，新条目追加（对应 Harness 的 bundle + patch 分层） */
export function mergeProfiles(...layers: Array<Profile | null | undefined>): Profile {
  const out: ProfileEntry[] = [];
  for (const p of layers) {
    for (const e of p?.plugins ?? []) {
      const i = out.findIndex((x) => x.name === e.name);
      if (i >= 0) out[i] = { ...out[i], ...e };
      else out.push({ ...e });
    }
  }
  return { plugins: out };
}

export async function loadProfile(root: Context, profile: Profile, catalog: Catalog): Promise<LoadResult> {
  const scopes = new Map<string, Scope>();
  const unknown: string[] = [];
  for (const e of profile.plugins) {
    if (e.disabled) continue;
    const p = catalog[e.name];
    if (!p) {
      unknown.push(e.name);
      continue;
    }
    scopes.set(e.name, root.plugin(p, e.config));
  }
  await root.kernel.settle();
  return { scopes, unresolved: unresolvedOf(root, [...scopes.values()]), unknown };
}

/**
 * 仍 pending 的插件。依赖图的边 = 「s 缺的服务由另一个 pending 插件声明 provides」，
 * 从 s 出发能走回 s 即依赖环；否则就是单纯缺服务（没人提供 / 提供者被禁用）。
 */
export function unresolvedOf(_root: Context, scopes: Scope[]): Unresolved[] {
  const pend = scopes.filter((s) => s.status === "pending");
  const next = (s: Scope) => pend.filter((o) => o !== s && s.missing.some((m) => o.provides.includes(m)));
  const reaches = (from: Scope, target: Scope) => {
    const seen = new Set<Scope>();
    const stack = next(from);
    while (stack.length) {
      const x = stack.pop()!;
      if (x === target) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...next(x));
    }
    return false;
  };
  return pend.map((s) => ({ name: s.name, missing: s.missing, cycle: reaches(s, s) }));
}
