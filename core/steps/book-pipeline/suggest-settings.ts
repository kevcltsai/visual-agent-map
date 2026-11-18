import { BOOK_SETTING_FIELDS, type BookSettings } from "../../book-pipeline/model";
import { singleLine } from "../../book-pipeline/text";
import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { renderTemplate, type StepDefinition } from "../../step-runner";
import { exactKeys, fail, languageInstruction, overBudget, parseJson, type BookStepBase } from "./base";
import { runPlanStep } from "./run";
import template from "./suggest-settings.md";

/** What the start card sends: the root topic's title and summary and its first-level chapter titles, nothing else. */
export interface SuggestSettingsRequest extends BookStepBase {
  bookTitle: string;
  summary: string;
  chapters: readonly string[];
}

export const SUGGEST_MAX_CHAPTERS = 40;
export const SUGGEST_CHAPTER_CHARS = 80;
export const SUGGEST_SUMMARY_CHARS = 300;
export const SUGGEST_VALUE_CHARS = 200;

export const SUGGEST_SETTINGS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: Object.fromEntries(BOOK_SETTING_FIELDS.map(field => [field, { type: "string" }])),
  required: [...BOOK_SETTING_FIELDS]
};

/** One suggestion as plain text: links keep their text, Markdown marks and list markers go, one line, at most 200 characters. */
export function plainSuggestion(value: string): string {
  const text = value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|\\]/g, "")
    .replace(/^\s*(?:[-+]|\d+[.)])\s+/, "");
  return singleLine(text, SUGGEST_VALUE_CHARS);
}

/** Only the fields the model filled with something usable; a missing or empty one is simply absent (it stays blank on the card). */
export function parseSuggestSettings(raw: string): BookSettings {
  const item = parseJson(raw);
  exactKeys(item, [...BOOK_SETTING_FIELDS]);
  const out: BookSettings = {};
  for (const field of BOOK_SETTING_FIELDS) {
    const value = item[field];
    if (typeof value !== "string") return fail("suggestions must be strings");
    const line = plainSuggestion(value);
    if (line) out[field] = line;
  }
  return out;
}

const cap = (value: string, max: number): string => singleLine(value, max);
/** The start card's suggestion: one text-only call over the root topic's title, summary and chapter titles. */
export const suggestSettingsStep: StepDefinition<SuggestSettingsRequest, BookSettings> = {
  id: "book-pipeline.suggest-settings",
  version: 1,
  render: request =>
    renderTemplate(template, {
      languageInstruction: languageInstruction(request.language, request.bookTitle),
      bookTitle: JSON.stringify(cap(request.bookTitle, 200)),
      summary: JSON.stringify(cap(request.summary, SUGGEST_SUMMARY_CHARS)),
      chapters: JSON.stringify(
        request.chapters.slice(0, SUGGEST_MAX_CHAPTERS).map(title => cap(title, SUGGEST_CHAPTER_CHARS))
      )
    }),
  schema: SUGGEST_SETTINGS_SCHEMA,
  policy: prompt => overBudget(prompt, SUGGEST_SETTINGS_SCHEMA),
  parse: parseSuggestSettings
};

export function runSuggestSettings(
  aiCalls: AiCalls,
  request: SuggestSettingsRequest,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<BookSettings> {
  return runPlanStep(aiCalls, suggestSettingsStep, request, run);
}
