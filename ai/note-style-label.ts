import { translate, type UiLanguage } from "../i18n";
import type { RunStyle } from "./note-style-store";

/**
 * The research progress line: "Note style: <structure> · <voice> (<where the structure came from>)". Only the structure's
 * level names a source; a structure or voice set on the run or the topic adds no bracket.
 */
export function runStyleLabelText(
  label: Pick<RunStyle["label"], "templateName" | "toneName" | "templateSource">,
  language: UiLanguage
): string {
  return label.templateSource === "kind"
    ? translate(
        language,
        "ui.note_style_label_0_1_2",
        label.templateName,
        label.toneName,
        translate(language, "ui.note_style_source_kind")
      )
    : translate(language, "ui.note_style_label_0_1", label.templateName, label.toneName);
}
