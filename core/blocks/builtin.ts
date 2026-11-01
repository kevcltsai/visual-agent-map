import { instructionLanguageOf, type ContentLanguage, type TranslationKey } from "../../i18n";
import { builtinPresets } from "../../ai/prompt-presets";
import { OBSIDIAN_FORMAT, inLanguage } from "../steps/_shared/fragments";
import PlainTextZH from "./format/plain-text.zh.md";
import PlainTextEN from "./format/plain-text.en.md";
import StandardZhTW from "./template/standard.zh-TW.md";
import StandardZhCN from "./template/standard.zh-CN.md";
import StandardEn from "./template/standard.en.md";
import TextbookZhTW from "./template/textbook.zh-TW.md";
import TextbookZhCN from "./template/textbook.zh-CN.md";
import TextbookEn from "./template/textbook.en.md";

/**
 * Built-in note-style blocks: one registry of the text a block contributes to the task prompt, per category. Bodies
 * reuse the existing prompt files (the Obsidian format fragment, the tone presets), so a block's text equals what the
 * prompt carries today. Template bodies are the section files under ./template.
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

/** A template block's body is its section file text (canonical v2 without the tone and format switches). */
const template = (
  id: string,
  nameKey: TranslationKey,
  files: Record<"zh-TW" | "zh-CN" | "en", string>
): BuiltinBlock => ({
  category: "template",
  id,
  nameKey,
  body: language =>
    strip(
      files[
        language === "zh-TW" || language === "zh-CN"
          ? language
          : instructionLanguageOf(language) === "zh"
            ? "zh-TW"
            : "en"
      ]
    )
});

export const BUILTIN_BLOCKS: readonly BuiltinBlock[] = [
  template("standard", "ui.note_style_standard_short", {
    "zh-TW": StandardZhTW,
    "zh-CN": StandardZhCN,
    en: StandardEn
  }),
  template("textbook", "ui.note_style_textbook_short", {
    "zh-TW": TextbookZhTW,
    "zh-CN": TextbookZhCN,
    en: TextbookEn
  }),
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
