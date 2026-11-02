import { translate, type TranslationKey, type UiLanguage } from "../i18n";
import { STANDARD_TEMPLATE_ID, TEXTBOOK_TEMPLATE_ID } from "./detail-templates";
import { DEFAULT_TONE_ID } from "./prompt-presets";
import { builtinPairOf, type NoteStyleAliases } from "./note-style-upgrade";
import { parseBlockRef } from "../core/blocks/block-files";

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

/** The file name behind a `style:<name>` / `file:<name>` template id, or undefined for any other id. */
export function fileStyleName(templateId: string): string | undefined {
  return /^(?:style|file):/.test(templateId) ? templateId.replace(/^(?:style|file):/, "") : undefined;
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

/** Which style a picker row stands for: a built-in style id, or `file:<name>` of a template block the user wrote. */
export interface StyleRef {
  kind: "builtin" | "file";
  id: string;
}

/**
 * The style a stored template and tone pair stands for, when it is a built-in or a template block of the user. An old id
 * the upgrade moved to a block (`aliases`) stands for that block.
 */
export function styleRefOf(
  templateId: string | undefined,
  toneId: string | undefined,
  aliases: NoteStyleAliases = {}
): StyleRef | undefined {
  const builtin = builtinPairOf(templateId, toneId);
  if (builtin) return { kind: "builtin", id: builtin };
  if (parseBlockRef(templateId)?.kind === "file" && templateId) return { kind: "file", id: templateId };
  const moved =
    templateId && Object.prototype.hasOwnProperty.call(aliases, templateId) ? aliases[templateId] : undefined;
  if (moved?.template && parseBlockRef(moved.template)?.kind === "file") return { kind: "file", id: moved.template };
  return undefined;
}
