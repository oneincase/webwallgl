// 插件内核的唯一入口（D5）：editor/ 内一律从 "../core" / "./core" 引，
// 不要直接引子文件（唯一例外：editor/services/types.ts 的 `declare module "../core/context"`，
// 模块增强必须指向真正声明 Services 的那个模块）。
export * from "./context";
export * from "./registry";
export * from "./schema";
export * from "./loader";
