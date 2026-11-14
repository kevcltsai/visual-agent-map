import {
  instructionLanguageOf,
  translate,
  type ContentLanguage,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";
import { CANONICAL_LANGUAGES, type NoteStyleLanguage } from "../../ai/note-style-file";
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
import GuideZhTW from "./template/guide.zh-TW.md";
import GuideZhCN from "./template/guide.zh-CN.md";
import GuideEn from "./template/guide.en.md";
import ConclusionZhTW from "./template/conclusion.zh-TW.md";
import ConclusionZhCN from "./template/conclusion.zh-CN.md";
import ConclusionEn from "./template/conclusion.en.md";
import LeanZh from "./format/lean.zh.md";
import LeanEn from "./format/lean.en.md";
import RichZh from "./format/rich.zh.md";
import RichEn from "./format/rich.en.md";
import SkimZh from "./format/skim.zh.md";
import SkimEn from "./format/skim.en.md";

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
  /** Earlier names (any language) that still resolve to this block and stay reserved, after a rename. */
  readonly legacyNameKeys?: readonly TranslationKey[];
  /** Template blocks only: a section with no reliable material is left out whole (`DetailTemplate.omitEmpty`). */
  readonly omitEmpty?: boolean;
  /** Retired: still resolves and renders, but is not offered in new choices (a style that uses it keeps it, marked). */
  readonly retired?: boolean;
  /** The block's prompt text in the language's instruction language. */
  body(language: ContentLanguage): string;
  /** Template blocks only: the sections zone (same text as `body`). */
  sections?(language: ContentLanguage): string;
}

const strip = (text: string): string => (text.endsWith("\n") ? text.slice(0, -1) : text);

/** A tone block's body is the built-in tone preset text; academic rigor is the default tone and adds nothing. */
const tone = (
  id: string,
  nameKey: TranslationKey,
  legacyNameKeys?: readonly TranslationKey[],
  retired = false
): BuiltinBlock => ({
  category: "tone",
  id,
  nameKey,
  ...(retired ? { retired: true as const } : {}),
  ...(legacyNameKeys ? { legacyNameKeys } : {}),
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
 * A template block's body is its section file text (canonical v2 without the tone and format switches). The format rules
 * are a separate part (BUILTIN_FORMATS). `files` follow the order of CANONICAL_LANGUAGES.
 */
const template = (id: string, nameKey: TranslationKey, files: readonly string[], omitEmpty = false): BuiltinBlock => {
  const table = Object.fromEntries(CANONICAL_LANGUAGES.map((language, index) => [language, files[index]])) as Record<
    NoteStyleLanguage,
    string
  >;
  return {
    category: "template",
    id,
    nameKey,
    ...(omitEmpty ? { omitEmpty: true as const } : {}),
    body: language => strip(fileFor(table, language)),
    sections: language => strip(fileFor(table, language))
  };
};

/**
 * The whole text of a built-in template: its sections. The format rules are a part of their own (BUILTIN_FORMATS), so
 * the text a template editor opens and "restore default" writes holds no format rules zone.
 */
export function builtinTemplateText(id: string, language: ContentLanguage): string {
  return findBuiltinBlock("template", id).sections?.(language) ?? "";
}

export const BUILTIN_BLOCKS: readonly BuiltinBlock[] = [
  template("standard", "ui.structure_name_standard", [StandardZhTW, StandardZhCN, StandardEn]),
  template("textbook", "ui.structure_name_textbook", [TextbookZhTW, TextbookZhCN, TextbookEn]),
  template("hypothesis", "ui.structure_name_hypothesis", [HypothesisZhTW, HypothesisZhCN, HypothesisEn]),
  template("evidence", "ui.structure_name_evidence", [EvidenceZhTW, EvidenceZhCN, EvidenceEn], true),
  template("action", "ui.structure_name_action", [ActionZhTW, ActionZhCN, ActionEn]),
  template("atomic", "ui.structure_name_atomic", [AtomicZhTW, AtomicZhCN, AtomicEn], true),
  template("conclusion", "ui.structure_name_conclusion", [ConclusionZhTW, ConclusionZhCN, ConclusionEn]),
  template("guide", "ui.structure_name_guide", [GuideZhTW, GuideZhCN, GuideEn]),
  tone("academic", "ui.preset_name_academic", ["ui.preset_name_academic_old"]),
  tone("plain", "ui.preset_name_plain"),
  tone("magazine", "ui.preset_name_magazine", ["ui.preset_name_magazine_old"]),
  tone("picture-book", "ui.preset_name_picture_book"),
  tone("summary", "ui.preset_name_summary", undefined, true),
  tone("guide", "ui.preset_name_guide", undefined, true),
  tone("auto", "ui.preset_name_auto", undefined, true)
];

/** A built-in format rules part: its text in the language's instruction language (zh or en). */
export interface BuiltinFormat {
  readonly id: string;
  readonly nameKey: TranslationKey;
  text(language: ContentLanguage): string;
}

/** Two-way file text by instruction language. */
const byInstruction = (zh: string, en: string) => (language: ContentLanguage) =>
  instructionLanguageOf(language) === "zh" ? zh : en;

/**
 * The built-in format rules, apart from the structures. Standard is the Obsidian format fragment itself (no copy), so it
 * is byte-equal to what the prompt carried before; rich is the standard text plus an additional part, so its diagram and
 * HTML safety rules are the standard ones; lean is a file of its own; skim is the lean text plus its skim rules.
 */
export const BUILTIN_FORMATS: readonly BuiltinFormat[] = [
  { id: "standard", nameKey: "ui.format_name_standard", text: language => inLanguage(OBSIDIAN_FORMAT, language) },
  { id: "lean", nameKey: "ui.format_name_lean", text: byInstruction(LeanZh, LeanEn) },
  {
    id: "rich",
    nameKey: "ui.format_name_rich",
    text: language => `${inLanguage(OBSIDIAN_FORMAT, language)}\n\n${byInstruction(RichZh, RichEn)(language)}`
  },
  {
    id: "skim",
    nameKey: "ui.format_name_skim",
    text: language => `${byInstruction(LeanZh, LeanEn)(language)}\n\n${byInstruction(SkimZh, SkimEn)(language)}`
  }
];

/** The text of the built-in format rules `id`; an unknown id throws, it never turns into an empty text. */
export function lookupBuiltinFormat(id: string, language: ContentLanguage): string {
  const format = BUILTIN_FORMATS.find(item => item.id === id);
  if (!format) throw new Error(`Unknown built-in format: ${id}`);
  return format.text(language);
}

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
