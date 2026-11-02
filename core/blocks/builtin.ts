import {
  instructionLanguageOf,
  noteLanguageOf,
  translate,
  type ContentLanguage,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";
import { CANONICAL_LANGUAGES, type NoteStyleLanguage } from "../../ai/note-style-file";
import { templateFormatHeading } from "./template-block";
import { builtinPresets } from "../../ai/prompt-presets";
import { OBSIDIAN_FORMAT, inLanguage } from "../steps/_shared/fragments";
import StandardZhTW from "./template/standard.zh-TW.md";
import StandardZhCN from "./template/standard.zh-CN.md";
import StandardEn from "./template/standard.en.md";
import TextbookZhTW from "./template/textbook.zh-TW.md";
import TextbookZhCN from "./template/textbook.zh-CN.md";
import TextbookEn from "./template/textbook.en.md";
import HypothesisZhTW from "./template/hypothesis.zh-TW.md";
import HypothesisZhCN from "./template/hypothesis.zh-CN.md";
import HypothesisEn from "./template/hypothesis.en.md";
import EvidenceZhTW from "./template/evidence.zh-TW.md";
import EvidenceZhCN from "./template/evidence.zh-CN.md";
import EvidenceEn from "./template/evidence.en.md";
import ActionZhTW from "./template/action.zh-TW.md";
import ActionZhCN from "./template/action.zh-CN.md";
import ActionEn from "./template/action.en.md";
import AtomicZhTW from "./template/atomic.zh-TW.md";
import AtomicZhCN from "./template/atomic.zh-CN.md";
import AtomicEn from "./template/atomic.en.md";

/**
 * Built-in note-style blocks: one registry of the text a block contributes to the task prompt, per category. Bodies
 * reuse the existing prompt files (the Obsidian format fragment, the tone presets), so a block's text equals what the
 * prompt carries today. Template bodies are the section files under ./template.
 */
export type BlockCategory = "template" | "tone";
export interface BuiltinBlock {
  readonly category: BlockCategory;
  readonly id: string;
  readonly nameKey: TranslationKey;
  /** The block's prompt text in the language's instruction language. */
  body(language: ContentLanguage): string;
  /** Template blocks only: the sections zone (same text as `body`). */
  sections?(language: ContentLanguage): string;
  /** Template blocks only: the format rules zone. */
  format?(language: ContentLanguage): string;
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

/**
 * The section file of `language`: the canonical language's own file, otherwise the file of the first canonical
 * language that shares its instruction language.
 */
function fileFor(files: Readonly<Record<NoteStyleLanguage, string>>, language: ContentLanguage): string {
  const own = (files as Readonly<Record<string, string | undefined>>)[language];
  if (own !== undefined) return own;
  const match = CANONICAL_LANGUAGES.find(item => instructionLanguageOf(item) === instructionLanguageOf(language));
  return files[match ?? CANONICAL_LANGUAGES[0]];
}

/**
 * A template block's body is its section file text (canonical v2 without the tone and format switches); `format` is the
 * Obsidian format rules the prompt carries today. `files` follow the order of CANONICAL_LANGUAGES.
 */
const template = (id: string, nameKey: TranslationKey, files: readonly string[]): BuiltinBlock => {
  const table = Object.fromEntries(CANONICAL_LANGUAGES.map((language, index) => [language, files[index]])) as Record<
    NoteStyleLanguage,
    string
  >;
  return {
    category: "template",
    id,
    nameKey,
    body: language => strip(fileFor(table, language)),
    sections: language => strip(fileFor(table, language)),
    format: language => inLanguage(OBSIDIAN_FORMAT, language)
  };
};

/**
 * The whole text of a built-in template: the sections, the format rules heading, then today's Obsidian format rules.
 * The text a template editor opens and "restore default" writes.
 */
export function builtinTemplateText(id: string, language: ContentLanguage): string {
  const block = findBuiltinBlock("template", id);
  return `${block.sections?.(language)}\n\n# ${templateFormatHeading(noteLanguageOf(language))}\n\n${block.format?.(language)}`;
}

export const BUILTIN_BLOCKS: readonly BuiltinBlock[] = [
  template("standard", "ui.note_style_standard_short", [StandardZhTW, StandardZhCN, StandardEn]),
  template("textbook", "ui.note_style_textbook_short", [TextbookZhTW, TextbookZhCN, TextbookEn]),
  template("hypothesis", "ui.note_style_hypothesis_short", [HypothesisZhTW, HypothesisZhCN, HypothesisEn]),
  template("evidence", "ui.note_style_evidence_short", [EvidenceZhTW, EvidenceZhCN, EvidenceEn]),
  template("action", "ui.note_style_action_short", [ActionZhTW, ActionZhCN, ActionEn]),
  template("atomic", "ui.note_style_atomic_short", [AtomicZhTW, AtomicZhCN, AtomicEn]),
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

/**
 * The file text "Edit" writes for academic rigor, which is the default voice and has no built-in text: only a note that
 * says so. A tone file is read without HTML comments (`stripToneComments`), so this file counts as unmodified.
 */
export function academicToneNote(language: UiLanguage): string {
  return `${translate(language, "ui.block_academic_note")}\n`;
}

/** A tone file's text without its HTML comments; text without a comment is returned as it is (a lone "<" stays). */
export function stripToneComments(text: string): string {
  return /<!--[\s\S]*?-->/.test(text) ? text.replace(/<!--[\s\S]*?-->/g, "").trim() : text;
}
