import { getLang } from "../../bench/i18n";
import { textOf } from "../core";
import { et, extendDict } from "../i18n";
import type { I18nService } from "./types";

export function createI18nService(): I18nService {
  return {
    lang: () => getLang(),
    t: et,
    extend: extendDict,
    text: (v, fallback) => textOf(v, getLang(), fallback),
  };
}
