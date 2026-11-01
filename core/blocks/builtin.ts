import { instructionLanguageOf, type ContentLanguage, type TranslationKey } from "../../i18n";
import { builtinPresets } from "../../ai/prompt-presets";
import { OBSIDIAN_FORMAT, inLanguage } from "../steps/_shared/fragments";
import PlainTextZH from "./format/plain-text.zh.md";
import PlainTextEN from "./format/plain-text.en.md";

/**
 * Built-in note-style blocks: one registry of the text a block contributes to the task prompt, per category. Bodies
 * reuse the existing prompt files (the Obsidian format fragment, the tone presets), so a block's text equals what the
 * prompt carries today. Template bodies are registered by id and name here; their text arrives with the template files.
 */
export type BlockCategory = "template" | "tone" | "format";
export interface BuiltinBlock {
  readonly category: BlockCategory;
  readonly id: string;
  readonly nameKey: TranslationKey;
  /** The block's prompt text in the language's instruction language. */
  body(language: ContentLanguage): string;
}

const strip = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** A tone block's body is the built-in tone preset text; academic rigor is the default tone and adds nothing. */
const tone = (id: string, nameKey: TranslationKey): BuiltinBlock => ({
  category: "tone",
  id,
  nameKey,
  body: language =>
    id === "academic" ? "" : (builtinPresets(language, "tone").find(preset => preset.id === id)?.text ?? "")
});

export const BUILTIN_BLOCKS: readonly BuiltinBlock[] = [
  { category: "template", id: "standard", nameKey: "ui.note_style_standard_short", body: () => "" },
  { category: "template", id: "textbook", nameKey: "ui.note_style_textbook_short", body: () => "" },
  {
    category: "format",
    id: "standard-obsidian",
    nameKey: "ui.block_format_standard",
    body: language => inLanguage(OBSIDIAN_FORMAT, language)
  },
  {
    category: "format",
    id: "plain-text",
    nameKey: "ui.block_format_plain",
    body: language => strip(instructionLanguageOf(language) === "zh" ? PlainTextZH : PlainTextEN)
  },
  tone("academic", "ui.preset_name_academic"),
  tone("plain", "ui.preset_name_plain"),
  tone("magazine", "ui.preset_name_magazine"),
  tone("summary", "ui.preset_name_summary"),
  tone("guide", "ui.preset_name_guide"),
  tone("auto", "ui.preset_name_auto")
];

/** The built-in block of `category` and `id`; an unknown id throws, it never turns into an empty body. */
export function findBuiltinBlock(category: BlockCategory, id: string): BuiltinBlock {
  const block = BUILTIN_BLOCKS.find(item => item.category === category && item.id === id);
  if (!block) throw new Error(`Unknown built-in block: ${category}/${id}`);
  return block;
}

/** The text of the built-in block, in the language's instruction language. */
export function lookupBuiltinBlock(category: BlockCategory, id: string, language: ContentLanguage): string {
  return findBuiltinBlock(category, id).body(language);
}
