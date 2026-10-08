// 编辑器插件内核（PLUGIN-ARCHITECTURE §1）：Cordis 风格的 ctx + 服务 + 事件 + 可逆副作用。
//
// 一个插件 = apply(ctx, config)。插件经 ctx 注册的一切（服务、事件监听、贡献项、子插件、
// 定时器）都记在它自己的 Scope 上，卸载 / 依赖消失 / 重载时按注册的逆序撤销。
//
// 依赖：插件声明 inject（必需）/ optional（可选）服务名，内核在必需服务全部就绪后才
// apply；任一必需服务被撤下，插件退回 pending（副作用全部撤销），服务恢复后自动重新 apply。
// 同名服务按栈管理：后提供者生效，撤下后回落到上一个 —— 替换任一内置能力只要再 provide 一次。
//
// 权限：Scope 可带 allow 白名单（外部插件按清单授权），get / inject 只能拿到白名单内的服务，
// 白名单随子插件继承。内核零依赖、零 DOM：Node 里直接跑（verify-plugin-kernel）。

export type Disposer = () => void;

/** 服务表：各服务模块用声明合并往里加键，ctx.get 据此推断类型 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Services {}

export type ServiceName = keyof Services & string;

export type InjectSpec = readonly string[] | { required?: readonly string[]; optional?: readonly string[] };

export type PluginApply<C = unknown> = (ctx: Context, config: C) => void | Promise<void>;

export interface PluginObject<C = unknown> {
  name: string;
  inject?: InjectSpec;
  /** 声明会提供的服务（只用于装配诊断：缺服务 vs 依赖环） */
  provides?: readonly string[];
  /** 配置校验 / 补缺省；抛错 = 配置非法，插件进 failed */
  Config?: (raw: unknown) => C;
  apply: PluginApply<C>;
}

export type PluginClass<C = unknown> = { new (ctx: Context, config: C): unknown; inject?: InjectSpec; Config?: (raw: unknown) => C };

export type Plugin<C = unknown> = PluginObject<C> | PluginApply<C> | PluginClass<C>;

export type ScopeStatus = "pending" | "loading" | "active" | "failed" | "disposed";

export type KernelEvents = {
  "internal/error": [scope: Scope, error: unknown, where: string];
  "internal/status": [scope: Scope];
  "internal/service": [name: string];
};

const isClass = (p: unknown): p is PluginClass => typeof p === "function" && /^class[\s{]/.test(Function.prototype.toString.call(p));

function normInject(spec: InjectSpec | undefined): { required: string[]; optional: string[] } {
  if (!spec) return { required: [], optional: [] };
  if (Array.isArray(spec)) return { required: [...spec], optional: [] };
  const s = spec as { required?: readonly string[]; optional?: readonly string[] };
  return { required: [...(s.required ?? [])], optional: [...(s.optional ?? [])] };
}

function pluginName(p: Plugin<any>): string {
  if (typeof p === "function") return p.name || "anonymous";
  return p.name || "anonymous";
}

/** 连续出错到这个数，插件自动停用（崩溃隔离） */
export const ERROR_BUDGET = 5;

export class Scope {
  readonly id: number;
  readonly name: string;
  status: ScopeStatus = "pending";
  error: unknown = null;
  errors = 0;
  /** 权限白名单；null = 继承父级（根 = 不限） */
  allow: ReadonlySet<string> | null;
  /** 用户元数据（外部插件的清单、来源等） */
  meta: Record<string, unknown> = {};
  readonly required: string[];
  readonly optional: string[];
  readonly provides: string[];
  readonly children = new Set<Scope>();
  private disposers: Disposer[] = [];
  private gen = 0;
  readonly ctx: Context;

  constructor(
    readonly kernel: Kernel,
    readonly parent: Scope | null,
    readonly plugin: Plugin<any> | null,
    public config: unknown,
    allow: Iterable<string> | null,
  ) {
    this.id = kernel.nextId++;
    this.name = plugin ? pluginName(plugin) : "root";
    this.allow = allow ? new Set(allow) : null;
    const inj = plugin && typeof plugin !== "function" ? plugin.inject : plugin && isClass(plugin) ? plugin.inject : undefined;
    const n = normInject(inj);
    this.required = n.required;
    this.optional = n.optional;
    this.provides = plugin && typeof plugin === "object" ? [...(plugin.provides ?? [])] : [];
    this.ctx = new Context(kernel, this);
  }

  /** 有效白名单：自己的 ∩ 祖先的 */
  permits(service: string): boolean {
    for (let s: Scope | null = this; s; s = s.parent) if (s.allow && !s.allow.has(service)) return false;
    return true;
  }

  get missing(): string[] {
    return this.required.filter((n) => !this.kernel.has(n) || !this.permits(n));
  }

  /** 登记一个撤销动作（逆序执行） */
  collect(d: Disposer): Disposer {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      const i = this.disposers.indexOf(once);
      if (i >= 0) this.disposers.splice(i, 1);
      try {
        d();
      } catch (e) {
        this.kernel.report(this, e, "dispose");
      }
    };
    this.disposers.push(once);
    return once;
  }

  /** 撤销全部副作用（含子插件），状态回到 pending（可再 apply） */
  reset() {
    this.gen++;
    for (const c of [...this.children]) c.dispose();
    const list = this.disposers.splice(0);
    for (let i = list.length - 1; i >= 0; i--) list[i]();
  }

  /** 依赖满足就 apply，否则保持 pending */
  async refresh(): Promise<void> {
    if (this.status === "disposed" || this.status === "failed" || this.status === "loading" || this.status === "active") return;
    if (this.missing.length) return;
    await this.start();
  }

  private async start() {
    const p = this.plugin;
    this.setStatus("loading");
    const gen = ++this.gen;
    try {
      if (p) {
        const Cfg = typeof p !== "function" ? p.Config : isClass(p) ? p.Config : undefined;
        const cfg = Cfg ? Cfg(this.config) : this.config;
        if (typeof p !== "function") await p.apply(this.ctx, cfg);
        else if (isClass(p)) new p(this.ctx, cfg);
        else await (p as PluginApply)(this.ctx, cfg);
      }
      if (gen !== this.gen || this.status !== "loading") return;
      this.setStatus("active");
    } catch (e) {
      if (gen !== this.gen) return;
      this.fail(e, "apply");
    }
  }

  fail(e: unknown, where: string) {
    this.reset();
    this.error = e;
    this.setStatus("failed");
    this.kernel.report(this, e, where);
  }

  /** 依赖消失：撤销副作用，回到 pending 等它回来 */
  suspend() {
    if (this.status !== "active" && this.status !== "loading") return;
    this.reset();
    this.setStatus("pending");
  }

  dispose() {
    if (this.status === "disposed") return;
    this.reset();
    this.setStatus("disposed");
    this.parent?.children.delete(this);
    this.kernel.scopes.delete(this);
  }

  /** 重载：撤销后按（可能更新的）配置重新 apply；failed 状态也能借此恢复 */
  async reload(config?: unknown): Promise<void> {
    if (this.status === "disposed") return;
    if (config !== undefined) this.config = config;
    this.reset();
    this.error = null;
    this.errors = 0;
    this.setStatus("pending");
    await this.refresh();
  }

  private setStatus(s: ScopeStatus) {
    if (this.status === s) return;
    this.status = s;
    this.kernel.emitInternal("internal/status", this);
  }
}

type Listener = (...args: any[]) => unknown;

export class Kernel {
  nextId = 0;
  readonly scopes = new Set<Scope>();
  readonly root: Scope;
  private services = new Map<string, Array<{ value: unknown; owner: Scope }>>();
  private listeners = new Map<string, Set<{ fn: Listener; owner: Scope }>>();
  /** 服务变化后的依赖重算合批（同一微任务里多次 provide 只算一次） */
  private pendingRefresh: Promise<void> | null = null;
  /** 未处理错误的出口（默认打控制台）；宿主可换成诊断面板 */
  onError: (scope: Scope, error: unknown, where: string) => void = (s, e, w) => console.error(`[plugin ${s.name}] ${w}:`, e);

  constructor() {
    this.root = new Scope(this, null, null, undefined, null);
    this.root.status = "active";
  }

  has(name: string): boolean {
    return !!this.services.get(name)?.length;
  }

  peek(name: string): unknown {
    const st = this.services.get(name);
    return st?.length ? st[st.length - 1].value : undefined;
  }

  serviceNames(): string[] {
    return [...this.services.keys()].filter((k) => this.has(k));
  }

  provide(owner: Scope, name: string, value: unknown): Disposer {
    if (!name) throw new Error("服务名不能为空");
    let st = this.services.get(name);
    if (!st) this.services.set(name, (st = []));
    const entry = { value, owner };
    const prevTop = st[st.length - 1];
    st.push(entry);
    if (prevTop) this.dependentsOf(name, prevTop.owner).forEach((s) => s.suspend());
    else for (const s of this.dependentsOf(name, owner)) if (s.optional.includes(name)) s.suspend();
    this.emitInternal("internal/service", name);
    this.scheduleRefresh();
    return owner.collect(() => {
      const list = this.services.get(name)!;
      const i = list.indexOf(entry);
      if (i < 0) return;
      const wasTop = i === list.length - 1;
      list.splice(i, 1);
      if (wasTop) for (const s of this.dependentsOf(name, owner)) s.suspend();
      this.emitInternal("internal/service", name);
      this.scheduleRefresh();
    });
  }

  /** 依赖某服务的活跃插件（不含提供者自己及其祖先，避免自我挂起） */
  private dependentsOf(name: string, provider: Scope): Scope[] {
    const out: Scope[] = [];
    for (const s of this.scopes) {
      if (s.status !== "active" && s.status !== "loading") continue;
      if (!s.required.includes(name) && !s.optional.includes(name)) continue;
      let anc: Scope | null = provider;
      let self = false;
      for (; anc; anc = anc.parent) if (anc === s) self = true;
      if (!self) out.push(s);
    }
    return out;
  }

  scheduleRefresh(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    this.pendingRefresh = Promise.resolve().then(async () => {
      this.pendingRefresh = null;
      for (const s of [...this.scopes]) if (s.status === "pending") await s.refresh();
    });
    return this.pendingRefresh;
  }

  /** 等到当前没有待处理的依赖重算（测试 / 启动流程用） */
  async settle(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      await this.scheduleRefresh();
      const busy = [...this.scopes].some((s) => s.status === "loading" || (s.status === "pending" && !s.missing.length));
      if (!busy) return;
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  on(owner: Scope, name: string, fn: Listener): Disposer {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    const entry = { fn, owner };
    set.add(entry);
    return owner.collect(() => set!.delete(entry));
  }

  /** 同步广播；每个监听出错各自隔离，计入监听方插件的错误预算 */
  emit(name: string, ...args: unknown[]): void {
    for (const { fn, owner } of [...(this.listeners.get(name) ?? [])]) {
      try {
        fn(...args);
      } catch (e) {
        this.report(owner, e, `event ${name}`);
      }
    }
  }

  /** 顺序 await 每个监听（导出管线等钩子用）；出错直接抛给调用方 */
  async serial(name: string, ...args: unknown[]): Promise<void> {
    for (const { fn } of [...(this.listeners.get(name) ?? [])]) await fn(...args);
  }

  /** 第一个返回非 undefined 的监听胜出 */
  bail<T = unknown>(name: string, ...args: unknown[]): T | undefined {
    for (const { fn, owner } of [...(this.listeners.get(name) ?? [])]) {
      try {
        const r = fn(...args);
        if (r !== undefined) return r as T;
      } catch (e) {
        this.report(owner, e, `event ${name}`);
      }
    }
    return undefined;
  }

  emitInternal<K extends keyof KernelEvents>(name: K, ...args: KernelEvents[K]): void {
    for (const { fn } of [...(this.listeners.get(name) ?? [])]) {
      try {
        fn(...args);
      } catch {
        /* 内部事件监听出错不再回报，防递归 */
      }
    }
  }

  report(scope: Scope, error: unknown, where: string) {
    scope.errors++;
    this.onError(scope, error, where);
    this.emitInternal("internal/error", scope, error, where);
    if (scope !== this.root && scope.status === "active" && scope.errors >= ERROR_BUDGET) {
      scope.fail(new Error(`连续出错 ${scope.errors} 次，已自动停用（最后一次：${String((error as Error)?.message ?? error)}）`), "budget");
    }
  }
}

export type PluginOptions = { allow?: Iterable<string> | null; meta?: Record<string, unknown> };

/** 插件拿到的上下文：一切注册都经它，并自动挂到所属 Scope 上 */
export class Context {
  constructor(
    readonly kernel: Kernel,
    readonly scope: Scope,
  ) {}

  get name() {
    return this.scope.name;
  }

  /** 取服务；不存在或无权限抛错（声明在 inject 里的服务 apply 时保证就绪） */
  get<K extends ServiceName>(name: K): Services[K];
  get<T = unknown>(name: string): T;
  get(name: string): unknown {
    if (!this.scope.permits(name)) throw new Error(`插件 ${this.name} 无权访问服务 ${name}`);
    if (!this.kernel.has(name)) throw new Error(`服务 ${name} 未就绪（插件 ${this.name} 需在 inject 里声明它）`);
    return this.kernel.peek(name);
  }

  /** 可选服务：不存在或无权限返回 undefined */
  maybe<K extends ServiceName>(name: K): Services[K] | undefined;
  maybe<T = unknown>(name: string): T | undefined;
  maybe(name: string): unknown {
    return this.scope.permits(name) ? this.kernel.peek(name) : undefined;
  }

  provide<K extends ServiceName>(name: K, value: Services[K]): Disposer;
  provide(name: string, value: unknown): Disposer;
  provide(name: string, value: unknown): Disposer {
    return this.kernel.provide(this.scope, name, value);
  }

  on(name: string, fn: Listener): Disposer {
    return this.kernel.on(this.scope, name, fn);
  }

  emit(name: string, ...args: unknown[]): void {
    this.kernel.emit(name, ...args);
  }

  serial(name: string, ...args: unknown[]): Promise<void> {
    return this.kernel.serial(name, ...args);
  }

  bail<T = unknown>(name: string, ...args: unknown[]): T | undefined {
    return this.kernel.bail<T>(name, ...args);
  }

  /** 可逆副作用：fn 立即执行，返回的撤销函数在插件卸载时调用 */
  effect(fn: () => Disposer | void): Disposer {
    const d = fn();
    return this.scope.collect(typeof d === "function" ? d : () => {});
  }

  /** 往某个注册表服务里贡献一项（registry.add 的可逆包装） */
  contribute<T>(service: string, item: T): Disposer {
    const reg = this.get(service) as { add(item: T, owner?: string): Disposer };
    if (!reg || typeof reg.add !== "function") throw new Error(`服务 ${service} 不是注册表`);
    return this.effect(() => reg.add(item, this.name));
  }

  setTimeout(fn: () => void, ms: number): Disposer {
    const h = setTimeout(() => this.guard(fn, "timer")(), ms);
    return this.scope.collect(() => clearTimeout(h));
  }

  setInterval(fn: () => void, ms: number): Disposer {
    const h = setInterval(() => this.guard(fn, "timer")(), ms);
    return this.scope.collect(() => clearInterval(h));
  }

  /** 把回调包成「出错计入本插件预算、不外抛」 */
  guard<A extends unknown[], R>(fn: (...a: A) => R, where = "callback"): (...a: A) => R | undefined {
    return (...a: A) => {
      if (this.scope.status === "disposed" || this.scope.status === "failed") return undefined;
      try {
        return fn(...a);
      } catch (e) {
        this.kernel.report(this.scope, e, where);
        return undefined;
      }
    };
  }

  /** 加载子插件；随本插件一起卸载 */
  plugin<C>(p: Plugin<C>, config?: C, opts: PluginOptions = {}): Scope {
    const s = new Scope(this.kernel, this.scope, p, config, opts.allow ?? null);
    if (opts.meta) s.meta = { ...opts.meta };
    this.scope.children.add(s);
    this.kernel.scopes.add(s);
    this.scope.collect(() => s.dispose());
    void s.refresh();
    return s;
  }
}

/** 新建一个内核，返回根上下文 */
export function createKernel(): Context {
  return new Kernel().root.ctx;
}
