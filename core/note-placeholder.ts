import { translate } from "../i18n";

/** Whether a summary is the "no conclusion yet" placeholder (any language). Lives apart from the repository so core and runner code can use it without Obsidian. */
export const isPlaceholder = (value: string): boolean =>
  value === translate("zh-TW", "detail.no_conclusion_yet") || value === translate("en", "detail.no_conclusion_yet");
