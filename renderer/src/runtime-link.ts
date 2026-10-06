// 公共实例 → 内部 Runtime 的私有关联。播放包的 SceneInstance 不暴露 rt；
// 编辑器包（api/editor）经这里取回 rt.sceneCtl.editor，播放宿主零感知。
import type { Runtime } from "./shell";

const links = new WeakMap<object, Runtime>();

export function linkRuntime(instance: object, rt: Runtime): void {
  links.set(instance, rt);
}

export function runtimeOf(instance: object): Runtime | undefined {
  return links.get(instance);
}
