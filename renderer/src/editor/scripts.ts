// 脚本编辑（EDITOR-PLAN W8）的纯函数出口：语法预检与引擎沙箱同一 transform。
import type { SceneScriptCheck } from "../api/types";
import { checkSceneScript as check } from "../../vendor/we-scene/render/text.js";

export function checkSceneScript(script: string): SceneScriptCheck {
  return check(script) as SceneScriptCheck;
}
