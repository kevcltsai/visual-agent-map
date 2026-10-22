import { translate, type TranslationKey, type UiLanguage } from "../../i18n";
import { STANDARD_TEMPLATE_ID, TEXTBOOK_TEMPLATE_ID } from "../../ai/detail-templates";
import { DEFAULT_TONE_ID } from "../../ai/prompt-presets";

/**
 * The note-style menu is two stored values filled in together: a preset is one content template plus one writing tone.
 * Nothing here is stored; maps and notes keep only `detail-template` and `tone`.
 */
export interface NoteStylePreset {
  id: string;
  templateId: string;
  toneId: string;
  name: TranslationKey;
  /** The short name used inside "Keep current (…)" and "Use the default (…)". */
  short: TranslationKey;
  hint: TranslationKey;
}

export const NOTE_STYLE_PRESETS: readonly NoteStylePreset[] = [
  {
    id: "standard",
    templateId: STANDARD_TEMPLATE_ID,
    toneId: DEFAULT_TONE_ID,
    name: "ui.note_style_standard",
    short: "ui.note_style_standard_short",
    hint: "ui.note_style_standard_hint"
  },
  {
    id: "textbook",
    templateId: TEXTBOOK_TEMPLATE_ID,
    toneId: DEFAULT_TONE_ID,
    name: "ui.note_style_textbook",
    short: "ui.note_style_textbook_short",
    hint: "ui.note_style_textbook_hint"
  },
  {
    id: "summary",
    templateId: STANDARD_TEMPLATE_ID,
    toneId: "summary",
    name: "ui.note_style_summary",
    short: "ui.note_style_summary",
    hint: "ui.note_style_summary_hint"
  },
  {
    id: "plain",
    templateId: STANDARD_TEMPLATE_ID,
    toneId: "plain",
    name: "ui.note_style_plain",
    short: "ui.note_style_plain",
    hint: "ui.note_style_plain_hint"
  },
  {
    id: "guide",
    templateId: STANDARD_TEMPLATE_ID,
    toneId: "guide",
    name: "ui.note_style_guide",
    short: "ui.note_style_guide",
    hint: "ui.note_style_guide_hint"
  }
];

/** The preset a template and tone pair equals; an unset template counts as Standard and an unset tone as Academic. */
export function matchPreset(templateId: string | undefined, toneId: string | undefined): NoteStylePreset | undefined {
  const template = templateId || STANDARD_TEMPLATE_ID;
  const tone = toneId || DEFAULT_TONE_ID;
  return NOTE_STYLE_PRESETS.find(preset => preset.templateId === template && preset.toneId === tone);
}

/**
 * The short name of the style a template and tone pair makes: the preset's name, else "Custom: template · tone" using
 * `names` to turn each id into its display name.
 */
export function styleLabel(
  templateId: string | undefined,
  toneId: string | undefined,
  names: { template: (id: string) => string; tone: (id: string) => string },
  language: UiLanguage
): string {
  const preset = matchPreset(templateId, toneId);
  if (preset) return translate(language, preset.short);
  return translate(
    language,
    "ui.note_style_custom_0_1",
    names.template(templateId || STANDARD_TEMPLATE_ID),
    names.tone(toneId || DEFAULT_TONE_ID)
  );
}
