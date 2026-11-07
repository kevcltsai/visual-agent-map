import { translate, type UiLanguage } from "../i18n";
import type { RunStyle } from "./note-style-store";

/**
 * The research progress line: "Note style: <structure> · <voice> (<where the structure came from>)". Only the structure's
 * level names a source; a structure or voice set on the run or the topic adds no bracket, and neither does the
 * AI-suggested style while the AI decides the sections or keeps the note's (the name already says where they come from).
 */
export function runStyleLabelText(
  label: Pick<RunStyle["label"], "templateName" | "toneName" | "templateSource" | "aiSectionsMode">,
  language: UiLanguage
): string {
  const bracket =
    label.templateSource === "kind" && label.aiSectionsMode !== "decide" && label.aiSectionsMode !== "follow";
  return bracket
    ? translate(
        language,
        "ui.note_style_label_0_1_2",
        label.templateName,
        label.toneName,
        translate(language, "ui.note_style_source_kind")
      )
    : translate(language, "ui.note_style_label_0_1", label.templateName, label.toneName);
}
