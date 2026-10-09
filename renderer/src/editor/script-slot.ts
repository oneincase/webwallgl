/**
 * M12 / W8（单脚本沙箱热替换）：可热替换的脚本挂点 —— 纯逻辑模块。
 *
 * 为什么单独抽出来：这套「稳定转发句柄 + 换源码重新求值」的语义里，最容易写错、
 * 也最必须逐条守住的是**熔断状态必须跟着新沙箱**（5 错上限）。如果热替换用
 * `Object.assign(旧句柄, 新沙箱)` 之类的写法，沙箱内部对 `sandbox.disabled = true`
 * 的写入会落在**新沙箱自己**身上，而宿主读到的仍是旧句柄的 `disabled === false`
 * —— 熔断直接失效。转发句柄（get 透传 + 每次调用重新取函数）同时满足两条硬约束：
 *   1) 换源码后所有已登记的引用（run 队列 / propSandboxes / 指针回调 / 媒体钩子）
 *      仍然指向同一个物理对象，登记表一个都不用改；
 *   2) `.disabled` / `.errCount` 等状态读到的永远是**当前这一代**的值。
 *
 * 本文件不 import 引擎、不碰 window/document，可被 Node 直接加载离线驱动。
 */

export type ScriptSlotHost = {
  /** 首次登记：把稳定句柄放进宿主的求值/回调登记表 */
  register(sandbox: any): void;
  /** 撤掉该挂点在上一代留下的结构化报错（换源码后重新起算） */
  clearIssues(layerId: number | null, target: string): void;
  /** 编不过 / 无 export 的挂点计数（与装配期同一口径） */
  countSkipped(): void;
};

export type EditorScriptSlot = {
  layer: any;
  target: string;
  /** 当前源码（仅在成功替换后更新） */
  code: string;
  /** 这一代求值结果；null = 已停用（字段停在快照值） */
  current: any;
  /** 稳定转发句柄（identity 不变，永远指向 current） */
  sandbox: any;
  /** 用新源码重新求值；失败返回 false 且保持旧沙箱不动 */
  swap: (code: string) => boolean;
};

/** 停用态：所有登记表都可能持有句柄并按 `.disabled` 提前 continue。
 *  这里给全回调一个 no-op 兜底，避免「已停用但仍被调用」抛 TypeError。 */
export function disabledSandbox(): Record<string, unknown> {
  const d: Record<string, unknown> = {
    disabled: true,
    hasUpdate: false,
    hasCursorHook: false,
    hasMediaHook: false,
    hasResizeHook: false,
    hasApplyHook: false,
    hasAnimEventHook: false,
    errCount: 0,
    engine: { frametime: 0, runtime: 0, screenResolution: { x: 0, y: 0 }, timeOfDay: 0 },
    thisLayer: {},
  };
  for (const fn of [
    "init",
    "applyUserProperties",
    "callUpdate",
    "callCursor",
    "callMedia",
    "callResize",
    "callAnimEvent",
  ]) {
    d[fn] = () => undefined;
  }
  return d;
}

/** 转发句柄：属性读写与调用一律透到最新一代；函数调用每次都重新取，
 *  这样「热替换后旧引用还能调到新实现」不需要任何登记表配合。 */
export function forwardSandbox(get: () => any): any {
  return new Proxy(
    {},
    {
      get: (_t, k) => {
        const cur = get();
        if (!cur) return undefined;
        const v = cur[k as any];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          const now = get();
          if (!now || typeof now[k as any] !== "function") return undefined;
          return now[k as any](...args);
        };
      },
      set: (_t, k, v) => {
        const cur = get();
        if (cur) cur[k as any] = v;
        return true;
      },
      has: (_t, k) => {
        const cur = get();
        return !!cur && k in cur;
      },
      ownKeys: () => {
        const cur = get();
        return cur ? Reflect.ownKeys(cur) : [];
      },
      getOwnPropertyDescriptor: (_t, k) => {
        const cur = get();
        const d = cur ? Object.getOwnPropertyDescriptor(cur, k) : undefined;
        return d ? { ...d, configurable: true } : undefined;
      },
    },
  );
}

/**
 * 登记一个可热替换的脚本挂点。
 *
 * @param build    用**同一份 env** 重新求值的闭包（安全边界的唯一来源）
 * @param activate 首次装配与热替换共用的「init + 回调登记 + 进求值队列」，
 *                 带 first 标志：首次要把 init 体推迟到两阶段末端，热替换立刻跑
 */
export function createScriptSlot(opts: {
  layer: any;
  target: string;
  build: (code: string) => any;
  activate: (sb: any, first: boolean) => void;
  host: ScriptSlotHost;
}): EditorScriptSlot {
  const { layer, target, build, activate, host } = opts;
  const slot: EditorScriptSlot = {
    layer,
    target,
    code: "",
    current: null,
    sandbox: null,
    swap(code: string) {
      const fresh = build(code);
      if (!fresh) {
        // 与装配期同一口径：编不过 / 无 export 就走 skippedScripts 计数
        if (typeof code === "string" && code) host.countSkipped();
        return false;
      }
      const first = !slot.current;
      slot.current = fresh;
      slot.code = code;
      if (first) host.register(slot.sandbox);
      // 旧一代的错误先撤掉：换源码后「5 错上限」重新起算，
      // 脚本面板上残留的上一版报错必须一起消失（否则用户改对了还红着）。
      host.clearIssues(typeof layer?.id === "number" ? layer.id : null, target);
      activate(slot.sandbox, first);
      return true;
    },
  };
  slot.sandbox = forwardSandbox(() => slot.current || disabledSandbox());
  return slot;
}
