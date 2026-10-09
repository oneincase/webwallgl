#!/usr/bin/env node
/**
 * verify-plugin-kernel —— 编辑器插件内核（editor/core）的语义判据。
 *
 * 真源是 editor/core/*.ts：esbuild 打成临时 mjs 真跑。覆盖：
 *   inject 等待 / 依赖消失回 pending 且副作用全撤 / 服务恢复自动重 apply /
 *   同名服务栈（覆盖与回落）/ 卸载逆序撤销 / 重载幂等 / 监听出错隔离与错误预算 /
 *   权限白名单（含继承）/ profile 合并、缺服务与依赖环诊断 / 注册表栈与合批 / schema 规整。
 * M10/D3 追加：editor/services/commands.ts 的 register 路径（命令的唯一注册入口，
 *   内置与插件同 API：owner 归属、同 id 叠栈与回落、校验、键盘派发与 list() 枚举一致）。
 * 每组判据配变异红测：把内核改坏，确认对应判据变红（防自证）。
 */
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib/verify-kit.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "verify-plugin-kernel-"));
process.on("exit", () => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function loadCore(overrides = {}) {
  const plugins = [];
  if (Object.keys(overrides).length) {
    plugins.push({
      name: "mutate",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined));
      },
    });
  }
  const out = await build({
    entryPoints: [path.join(ROOT, "editor/core/index.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `core-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 跑全部判据，返回 [{ok, msg}]（不直接打印，变异红测复用） */
async function suite(K) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const silence = (root) => (root.kernel.onError = () => {});

  // ── inject 等待 / 回 pending / 恢复 ──
  {
    const root = K.createKernel();
    silence(root);
    const log = [];
    const B = { name: "b", inject: ["a"], apply(ctx) { log.push(`apply:${ctx.get("a").v}`); ctx.effect(() => () => log.push("dispose")); } };
    const A = { name: "a", provides: ["a"], apply(ctx, cfg) { ctx.provide("a", { v: cfg }); } };
    const sb = root.plugin(B);
    await root.kernel.settle();
    check(sb.status === "pending" && log.length === 0, "inject：服务没到之前插件不 apply（pending）");
    const sa = root.plugin(A, 1);
    await root.kernel.settle();
    check(sb.status === "active" && log.join() === "apply:1", "服务就绪后自动 apply，拿到的是该服务");
    sa.dispose();
    await root.kernel.settle();
    check(sb.status === "pending" && log.join() === "apply:1,dispose", "提供者卸载：依赖方回 pending，副作用撤销");
    root.plugin(A, 2);
    await root.kernel.settle();
    check(sb.status === "active" && log.at(-1) === "apply:2", "服务恢复：依赖方自动重新 apply（拿到新实例）");
  }

  // ── 服务栈：覆盖与回落 ──
  {
    const root = K.createKernel();
    silence(root);
    const seen = [];
    root.plugin({ name: "user", inject: ["svc"], apply(ctx) { seen.push(ctx.get("svc")); } });
    root.plugin({ name: "p1", apply(ctx) { ctx.provide("svc", "builtin"); } });
    await root.kernel.settle();
    const p2 = root.plugin({ name: "p2", apply(ctx) { ctx.provide("svc", "override"); } });
    await root.kernel.settle();
    check(root.kernel.peek("svc") === "override" && seen.at(-1) === "override", "后提供者覆盖同名服务，依赖方切到新实现");
    p2.dispose();
    await root.kernel.settle();
    check(root.kernel.peek("svc") === "builtin" && seen.at(-1) === "builtin", "覆盖者卸载：回落到原实现，依赖方重新 apply");
  }

  // ── 逆序撤销 / 重载幂等 / 子插件随父卸载 ──
  {
    const root = K.createKernel();
    silence(root);
    const order = [];
    let live = 0;
    const P = {
      name: "p",
      apply(ctx) {
        live++;
        ctx.effect(() => () => order.push(1));
        ctx.effect(() => () => order.push(2));
        ctx.effect(() => () => live--);
        ctx.plugin({ name: "child", apply(c) { c.effect(() => () => order.push("child")); } });
      },
    };
    const s = root.plugin(P);
    await root.kernel.settle();
    for (let i = 0; i < 5; i++) await s.reload();
    await root.kernel.settle();
    check(live === 1, `重载 5 次后活跃副作用恰为 1 份（实得 ${live}）`);
    order.length = 0;
    s.dispose();
    check(order.join() === "child,2,1" && live === 0, `卸载：子插件先撤，自身副作用逆序撤销（实得 ${order.join()}）`);
    check(s.status === "disposed" && !root.kernel.scopes.has(s), "卸载后状态 disposed 且移出内核");
  }

  // ── 事件：监听随插件撤销、出错隔离、错误预算 ──
  {
    const root = K.createKernel();
    const errs = [];
    root.kernel.onError = (s, e) => errs.push(s.name);
    let got = 0;
    const good = root.plugin({ name: "good", apply(ctx) { ctx.on("ping", () => got++); } });
    const bad = root.plugin({ name: "bad", apply(ctx) { ctx.on("ping", () => { throw new Error("boom"); }); } });
    await root.kernel.settle();
    root.emit("ping");
    check(got === 1 && errs.join() === "bad", "一个监听出错不影响其他监听，错误记在出错插件名下");
    for (let i = 0; i < K.ERROR_BUDGET; i++) root.emit("ping");
    check(bad.status === "failed", `连续出错达到预算（${K.ERROR_BUDGET}）自动停用`);
    const before = got;
    root.emit("ping");
    // 预算内 5 次 + 停用通知 1 次；停用后再广播不再新增
    check(got === before + 1 && errs.length === K.ERROR_BUDGET + 1, `停用后它的监听已撤下（不再报错），好插件照常（错误 ${errs.length} 条）`);
    good.dispose();
    root.emit("ping");
    check(got === before + 1, "插件卸载后监听不再触发");
    await bad.reload();
    check(bad.status === "active" && bad.errors === 0, "failed 的插件可以 reload 恢复（错误计数清零）");
  }

  // ── apply 抛错 → failed，不影响别人 ──
  {
    const root = K.createKernel();
    silence(root);
    let undone = 0;
    const s = root.plugin({ name: "x", apply(ctx) { ctx.effect(() => () => undone++); throw new Error("nope"); } });
    const ok = root.plugin({ name: "ok", apply() {} });
    await root.kernel.settle();
    check(s.status === "failed" && undone === 1 && ok.status === "active", "apply 抛错：该插件 failed 且已注册的副作用撤销，其他插件不受影响");
    const c = root.plugin({ name: "cfg", Config: (r) => { if (typeof r !== "number") throw new Error("bad"); return r; }, apply() {} }, "str");
    await root.kernel.settle();
    check(c.status === "failed", "Config 校验不过 → failed");
  }

  // ── 权限白名单 ──
  {
    const root = K.createKernel();
    silence(root);
    root.plugin({ name: "prov", apply(ctx) { ctx.provide("doc", 1); ctx.provide("fs", 2); } });
    let denied = false;
    let childDenied = false;
    const s = root.plugin(
      {
        name: "ext",
        inject: { optional: ["fs"] },
        apply(ctx) {
          check(ctx.get("doc") === 1, "白名单内的服务可取");
          try { ctx.get("fs"); } catch { denied = true; }
          check(ctx.maybe("fs") === undefined, "白名单外的可选服务 maybe 得 undefined");
          ctx.plugin({ name: "sub", apply(c) { try { c.get("fs"); } catch { childDenied = true; } } });
        },
      },
      undefined,
      { allow: ["doc"] },
    );
    await root.kernel.settle();
    check(s.status === "active" && denied && childDenied, "白名单外的服务 get 抛错，子插件继承白名单");
    const need = root.plugin({ name: "need", inject: ["fs"], apply() {} }, undefined, { allow: ["doc"] });
    await root.kernel.settle();
    check(need.status === "pending" && need.missing.join() === "fs", "inject 了无权限的服务 → 一直 pending（视为缺失）");
  }

  // ── profile：合并 / 未知 / 缺服务 / 依赖环 ──
  {
    const m = K.mergeProfiles({ plugins: [{ name: "a", config: 1 }, { name: "b" }] }, { plugins: [{ name: "a", disabled: true }, { name: "c" }] });
    check(JSON.stringify(m.plugins) === JSON.stringify([{ name: "a", config: 1, disabled: true }, { name: "b" }, { name: "c" }]), "mergeProfiles：同名覆盖、新条目追加");
    const root = K.createKernel();
    silence(root);
    const catalog = {
      x: { name: "x", inject: ["y"], provides: ["x"], apply(ctx) { ctx.provide("x", 1); } },
      y: { name: "y", inject: ["x"], provides: ["y"], apply(ctx) { ctx.provide("y", 1); } },
      lone: { name: "lone", inject: ["nobody"], apply() {} },
      fine: { name: "fine", apply() {} },
    };
    const r = await K.loadProfile(root, { plugins: [{ name: "x" }, { name: "y" }, { name: "lone" }, { name: "fine" }, { name: "ghost" }] }, catalog);
    const by = Object.fromEntries(r.unresolved.map((u) => [u.name, u]));
    check(by.x?.cycle && by.y?.cycle, "x↔y 互相依赖判为依赖环");
    check(by.lone && !by.lone.cycle && by.lone.missing.join() === "nobody", "缺服务（没人提供）不误判为环");
    check(r.scopes.get("fine")?.status === "active" && r.unknown.join() === "ghost", "无关插件照常装配；catalog 里没有的列入 unknown");
  }

  // ── 注册表 ──
  {
    const reg = K.createRegistry("fx");
    let fired = 0;
    reg.onChange(() => fired++);
    const d1 = reg.add({ id: "a", v: 1 }, "p1");
    reg.add({ id: "b", v: 1 }, "p1");
    const d3 = reg.add({ id: "a", v: 2 }, "p2");
    await tick();
    check(fired === 1, `同一微任务内多次 add 只触发一次 changed（实得 ${fired}）`);
    check(reg.get("a").v === 2 && reg.ownerOf("a") === "p2" && reg.list().map((x) => x.id).join() === "a,b", "同 id 后加覆盖，列表顺序按首次加入");
    d3();
    check(reg.get("a").v === 1, "覆盖项撤下后回落");
    d1();
    reg.setFallback([{ id: "a", v: 0 }]);
    check(reg.get("a").v === 0 && !reg.list().some((x) => x.id === "a"), "fallback 只兜 get，不进 list");
    const root = K.createKernel();
    root.plugin({ name: "reg", apply(ctx) { ctx.provide("things", reg); } });
    const c = root.plugin({ name: "contrib", inject: ["things"], apply(ctx) { ctx.contribute("things", { id: "z" }); } });
    await root.kernel.settle();
    check(reg.has("z") && reg.ownerOf("z") === "contrib", "ctx.contribute 以插件名为 owner 加入注册表");
    c.dispose();
    check(!reg.has("z"), "贡献插件卸载 → 贡献项自动撤下");
  }

  // ── schema ──
  {
    const f = { key: "k", type: "float", min: 0, max: 1, default: 0.5 };
    check(K.coerce(f, 3) === 1 && K.coerce(f, "x") === 0.5, "float：越界夹取，非数回落缺省");
    check(JSON.stringify(K.coerce({ key: "c", type: "color" }, "2 0.5 -1")) === "[1,0.5,0]", "color：字符串解析并夹到 0..1");
    check(K.coerce({ key: "e", type: "enum", options: ["a", "b"] }, "c") === "a", "enum：非法值回落首项");
    check(JSON.stringify(K.resolveConfig([f], { k: 0.2, junk: 1 })) === '{"k":0.2}', "resolveConfig：丢未知键");
    let threw = false;
    try { K.parseSchema([{ key: "1bad", type: "float" }]); } catch { threw = true; }
    check(threw, "parseSchema：非法 key 抛错");
  }
  return res;
}

/** M10/D3：命令注册 API —— 打 editor/services/commands.ts（内部会带上 core 一起打） */
async function loadCommands(overrides = {}) {
  const plugins = [];
  if (Object.keys(overrides).length) {
    plugins.push({
      name: "mutate",
      setup(b) {
        b.onLoad({ filter: /\.ts$/ }, (a) => (overrides[a.path] !== undefined ? { contents: overrides[a.path], loader: "ts" } : undefined));
      },
    });
  }
  const out = await build({
    entryPoints: [path.join(ROOT, "editor/services/commands.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    plugins,
    logLevel: "silent",
  });
  const tmp = path.join(tmpRoot, `cmd-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, out.outputFiles[0].text);
  return import(pathToFileURL(tmp).href);
}

/** D3 判据：register 是命令的唯一注册入口，键盘派发与 list() 枚举都看同一份 registry */
async function cmdSuite(C) {
  const res = [];
  const check = (ok, msg) => res.push({ ok: !!ok, msg });
  const s = C.createCommandService();
  const ids = () => s.registry.list().map((c) => c.id).join(",");
  const off = s.register({ id: "edit.test", keys: "Mod+Shift+P", run: (a) => `ran:${String(a)}` }, "builtin-ui");
  check(s.registry.has("edit.test") && s.registry.ownerOf("edit.test") === "builtin-ui",
    "register：命令进 registry，owner 记成注册方（内置也走同一条路）");
  check(s.exec("edit.test", 1) === "ran:1", "register 后的命令能被 exec 派发");
  check(s.handleKey({ key: "P", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false }) === true,
    "register 后的命令能被键盘派发（派发仍走同一份 registry 枚举）");
  const off2 = s.register({ id: "edit.test", keys: "Mod+Shift+P", run: () => "override" }, "ext:demo");
  check(s.registry.ownerOf("edit.test") === "ext:demo" && s.exec("edit.test") === "override" && ids() === "edit.test",
    `同 id 后注册优先：栈顶那条生效，list() 仍只有一条（插件覆盖内置；枚举 ${ids()}）`);
  off2();
  check(s.registry.ownerOf("edit.test") === "builtin-ui" && s.exec("edit.test") === "ran:undefined" && ids() === "edit.test",
    "撤下后注册的那条 → 回落到先注册的内置版（行为与 registry.add 逐位一致）");
  let threw = "";
  try { s.exec("nope"); } catch (e) { threw = e.message; }
  check(threw === "未知命令：nope", `未知命令抛错（${threw}）`);
  threw = "";
  try { s.register({ id: "", run: () => 0 }); } catch (e) { threw = e.message; }
  check(threw === "命令必须有非空 id", `register 校验：空 id 抛错（${threw}）`);
  threw = "";
  try { s.register({ id: "x.y" }); } catch (e) { threw = e.message; }
  check(threw === "命令 x.y 缺少 run", `register 校验：缺 run 抛错（${threw}）`);
  const offW = s.register({ id: "edit.when", when: () => false, run: () => "no" });
  check(s.exec("edit.when") === undefined && s.handleKey({ key: "Q", metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }) === false,
    "when 为假 → exec 返回 undefined、键盘不吞事件（行为未变）");
  offW();
  off();
  check(!s.registry.has("edit.test") && ids() === "", "register 返回的 Disposer 只撤自己那条");
  return res;
}
let failed = 0;
console.log("verify-plugin-kernel");
const real = await suite(await loadCore());
const realCmd = await cmdSuite(await loadCommands());
for (const r of [...real, ...realCmd]) {
  console[r.ok ? "log" : "error"](`  ${r.ok ? "✓" : "✗"} ${r.msg}`);
  if (!r.ok) failed++;
}

console.log("\n变异红测");
const ctxPath = path.join(ROOT, "editor/core/context.ts");
const regPath = path.join(ROOT, "editor/core/registry.ts");
const ctxSrc = fs.readFileSync(ctxPath, "utf8");
const regSrc = fs.readFileSync(regPath, "utf8");
const mutants = [
  ["卸载不逆序", ctxPath, ctxSrc, "for (let i = list.length - 1; i >= 0; i--) list[i]();", "for (let i = 0; i < list.length; i++) list[i]();"],
  ["依赖消失不挂起", ctxPath, ctxSrc, "if (wasTop) for (const s of this.dependentsOf(name, owner)) s.suspend();", "void wasTop;"],
  ["监听不隔离", ctxPath, ctxSrc, "        fn(...args);\n      } catch (e) {\n        this.report(owner, e, `event ${name}`);\n      }\n    }\n  }\n\n  /** 顺序", "        fn(...args);\n      } catch (e) {\n        throw e;\n      }\n    }\n  }\n\n  /** 顺序"],
  ["白名单不继承", ctxPath, ctxSrc, "for (let s: Scope | null = this; s; s = s.parent)", "for (let s: Scope | null = this; s; s = null)"],
  ["重载不撤旧副作用", ctxPath, ctxSrc, "    if (config !== undefined) this.config = config;\n    this.reset();", "    if (config !== undefined) this.config = config;"],
  ["注册表不回落", regPath, regSrc, "list!.splice(i, 1);", "list!.splice(0, list!.length);"],
  ["changed 不合批", regPath, regSrc, "    if (queued) return;\n    queued = true;", "    queued = false;"],
];
for (const [label, file, src, from, to] of mutants) {
  if (!src.includes(from)) {
    console.error(`  ✗ ${label}：注入点不存在（内核改过？同步更新本脚本）`);
    failed++;
    continue;
  }
  let res;
  try {
    res = await suite(await loadCore({ [file]: src.replace(from, to) }));
  } catch {
    res = [{ ok: false }];
  }
  const red = res.filter((r) => !r.ok).length;
  console[red ? "log" : "error"](`  ${red ? "✓" : "✗"} ${label} → ${red} 条判据变红`);
  if (!red) failed++;
}

// ── D3 变异红测：命令注册 API ──
const cmdPath = path.join(ROOT, "editor/services/commands.ts");
const cmdSrc = fs.readFileSync(cmdPath, "utf8");
const cmdMutants = [
  ["register 不校验 run", cmdPath, cmdSrc, "if (typeof def.run !== \"function\") throw new Error(`命令 ${def.id} 缺少 run`);", ""],
  ["register 丢掉 owner", cmdPath, cmdSrc, "return registry.add(def, owner);", "return registry.add(def);"],
  ["register 不再进注册表", cmdPath, cmdSrc, "return registry.add(def, owner);", "void def; return () => {};"],
];
for (const [label, file, src, from, to] of cmdMutants) {
  if (!src.includes(from)) {
    console.error(`  ✗ ${label}：注入点不存在（命令服务改过？同步更新本脚本）`);
    failed++;
    continue;
  }
  let res;
  try {
    res = await cmdSuite(await loadCommands({ [file]: src.replace(from, to) }));
  } catch {
    res = [{ ok: false }];
  }
  const red = res.filter((r) => !r.ok).length;
  console[red ? "log" : "error"](`  ${red ? "✓" : "✗"} ${label} → ${red} 条判据变红`);
  if (!red) failed++;
}

const total = real.length + realCmd.length;
const bad = [...real, ...realCmd].filter((r) => !r.ok).length;
console.log(`\n${failed ? "✗" : "✓"} verify-plugin-kernel：${total - bad}/${total} 判据通过，${failed} 项失败`);
process.exit(failed ? 1 : 0);
