import { en, type TranslationKey } from "./i18n/en";
import {
  FOLLOW_ANCHOR_KINDS,
  FOLLOW_ANCHOR_MAX,
  FOLLOW_INPUT_ID,
  LANGUAGES,
  OUTPUT_LANGUAGES,
  type FollowAnchor,
  type FollowAnchorKind,
  type InstructionLanguage,
  type LanguageEntry,
  type OutputLanguageEntry,
  type OutputOnlyId,
  type NoteHeadings,
  type NoteHeadingName,
  type NoteLanguage,
  type PromptNameForm,
  type UiLanguage
} from "./i18n/languages";

/**
 * Any language the AI can write content in: an interface language, or an output-only language (`OUTPUT_LANGUAGES`).
 * Interface surfaces (`UiLanguage`) never take the output-only ids.
 */
export type ContentLanguage = UiLanguage | OutputOnlyId;
export type { FollowAnchor, FollowAnchorKind, InstructionLanguage, NoteHeadingName, NoteHeadings, NoteLanguage, OutputLanguageEntry, OutputOnlyId, PromptNameForm, TranslationKey, UiLanguage };
export { FOLLOW_INPUT_ID, LANGUAGES, OUTPUT_LANGUAGES };

const registry: ReadonlyArray<LanguageEntry> = LANGUAGES;
/** The interface language used when a stored or requested language is not registered. */
const FALLBACK_LANGUAGE: UiLanguage = "en";
const outputRegistry: ReadonlyArray<OutputLanguageEntry> = OUTPUT_LANGUAGES;
const entryOf = (locale: ContentLanguage): LanguageEntry | OutputLanguageEntry =>
  registry.find(item => item.id === locale) ??
  outputRegistry.find(item => item.id === locale) ??
  registry.find(item => item.id === FALLBACK_LANGUAGE)!;

/** The section headings a new note gets under interface language `locale` (an unknown id reads the fallback row). */
export function noteHeadingsOf(locale: UiLanguage): NoteHeadings {
  return (registry.find(item => item.id === locale) ?? registry.find(item => item.id === FALLBACK_LANGUAGE)!).noteHeadings;
}
/** Every registered heading set, in registry order: a note written with any of them is read (C8). */
export const NOTE_HEADING_SETS: readonly NoteHeadings[] = registry.map(item => item.noteHeadings);
/** The interface language a registered heading set belongs to (the fallback language for a set not in the registry). */
export function uiLanguageOfHeadings(set: NoteHeadings): UiLanguage {
  return (registry.find(item => item.noteHeadings === set)?.id ?? FALLBACK_LANGUAGE) as UiLanguage;
}
/** Every language fixed note text can be written in (the registry's distinct `note` values), in registry order. */
export const NOTE_LANGUAGES: readonly NoteLanguage[] = [...new Set(registry.map(item => item.note))];

/**
 * Every language VAM supports, in menu order. Language menus (settings, output language, image translation) read
 * this list, so a newly supported language appears in all of them. `name` is the English name used in AI prompts.
 */
export const SUPPORTED_LANGUAGES: ReadonlyArray<{ id: UiLanguage; label: string; name: string }> = LANGUAGES.map(({ id, label, name }) => ({ id, label, name }));
/**
 * Output-only languages, in menu order: selectable as an output language but never as the interface language. The
 * "same as the input" row is not a language and is left out; menus list it separately (see {@link isFollowInputLanguage}).
 */
export const OUTPUT_LANGUAGE_CHOICES: ReadonlyArray<{ id: OutputOnlyId; label: string; name: string }> = outputRegistry
  .filter(item => !item.followsInput)
  .map(({ id, label, name }) => ({ id: id as OutputOnlyId, label, name }));
/** True for the virtual "same language as the user's own text" row (not a language of its own). */
export function isFollowInputLanguage(value: unknown): boolean {
  return outputRegistry.some(item => item.id === value && item.followsInput === true);
}
/** Name of a language for menus and summaries; the follow-the-input row is named in the interface language. */
export function supportedLanguageLabel(id: string): string {
  if (isFollowInputLanguage(id)) return t("ui.output_language_follow_input");
  return (
    SUPPORTED_LANGUAGES.find(item => item.id === id)?.label ?? OUTPUT_LANGUAGE_CHOICES.find(item => item.id === id)?.label ?? id
  );
}

/** True for a registered interface-language id. */
export function isUiLanguage(value: unknown): value is UiLanguage {
  return registry.some(item => item.id === value);
}
/** True for any language the AI can write in: an interface language or an output-only one. */
export function isContentLanguage(value: unknown): value is ContentLanguage {
  return isUiLanguage(value) || outputRegistry.some(item => item.id === value);
}
/** True for a language that fixed note text can be written in; use this for persisted values read back from notes and maps. */
export function isNoteLanguage(value: unknown): value is NoteLanguage {
  return isUiLanguage(value) && entryOf(value).note === value;
}
/** The language fixed note text is written in when the interface is `locale`. */
export function noteLanguageOf(locale: ContentLanguage): NoteLanguage { return entryOf(locale).note; }
/** The prompt fragment set (`zh` or `en`) used to instruct the AI when the interface is `locale`. */
export function instructionLanguageOf(locale: ContentLanguage): InstructionLanguage { return entryOf(locale).instruction; }
/**
 * The language to name as the output content language: the interface language when its note language equals `note`
 * (so a Simplified Chinese interface keeps writing Simplified Chinese prose), otherwise `note` itself.
 */
export function contentLocale(note: NoteLanguage, ui: UiLanguage): UiLanguage { return noteLanguageOf(ui) === note ? ui : note; }
/**
 * The note language whose fixed headings a prompt must have the model copy verbatim, or null when the output locale
 * already is its note language (zh-TW, en). Only a locale whose note language differs (zh-CN) needs the extra rule.
 */
export function verbatimHeadingLanguage(output: ContentLanguage): NoteLanguage | null {
  const note = noteLanguageOf(output);
  return note === output ? null : note;
}
/** How a prompt written in `instruction` names language `locale`, in the given `form`. */
export function languagePromptName(
  locale: ContentLanguage,
  instruction: InstructionLanguage,
  form: PromptNameForm,
  anchor?: FollowAnchor
): string {
  const entry = entryOf(locale);
  const anchored = "anchored" in entry ? entry.anchored : undefined;
  const quoted = anchor && anchored ? quoteAnchor(anchor.text) : "";
  if (!anchor || !anchored || !quoted) return entry.prompt[instruction][form];
  return anchored[instruction]
    .replace("{kind}", () => FOLLOW_ANCHOR_KINDS[anchor.kind][instruction])
    // The Chinese clause is wrapped in 「」, so the user's own 「」 become 『』 to keep the quote unambiguous.
    .replace("{anchor}", () => (instruction === "zh" ? quoted.replace(/「/g, "『").replace(/」/g, "』") : quoted));
}
/** The user's own words as they are quoted inside the follow-the-input clause: one line, cut to the limit, quotes escaped. */
function quoteAnchor(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const chars = Array.from(flat);
  const cut = chars.length > FOLLOW_ANCHOR_MAX ? `${chars.slice(0, FOLLOW_ANCHOR_MAX).join("").trimEnd()}…` : flat;
  return cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
/** BCP 47 tag for `Intl` formatting of `locale`. */
export function intlLocaleOf(locale: ContentLanguage): string { return entryOf(locale).intl; }

let language: UiLanguage = FALLBACK_LANGUAGE;
/**
 * The interface language that matches an app language code (Obsidian's `getLanguage()`, such as "zh-TW", "zh" or "en", or a
 * BCP 47 tag such as "zh-Hant-HK"), or null when VAM has no interface in that language.
 */
export function uiLanguageFromAppLocale(locale: unknown): UiLanguage | null {
  if (typeof locale !== "string" || !locale.trim()) return null;
  const tag = locale.trim().toLowerCase().replace(/_/g, "-");
  const byId = (id: string): UiLanguage | null => {
    const found = registry.find(item => item.id.toLowerCase() === id)?.id;
    return isUiLanguage(found) ? found : null;
  };
  const exact = byId(tag);
  if (exact) return exact;
  // Traditional Chinese is named by script (Hant) or by region (Taiwan, Hong Kong, Macau); any other Chinese is Simplified.
  if (/^zh(-|$)/.test(tag)) {
    const traditional = /(^|-)(hant|tw|hk|mo)(-|$)/.test(tag.slice(2));
    const id = traditional ? "zh-TW" : "zh-CN";
    return isUiLanguage(id) ? id : null;
  }
  return byId(tag.split("-")[0]);
}
/**
 * The saved interface language. When none was ever saved (a new install), the app's own language when VAM has an interface
 * in it; English otherwise, and also for a saved value that is invalid or was written by a newer version.
 */
export function initialUiLanguage(saved: unknown, appLocale?: unknown): UiLanguage {
  if (isUiLanguage(saved)) return saved;
  if (saved === undefined || saved === null) return uiLanguageFromAppLocale(appLocale) ?? FALLBACK_LANGUAGE;
  return FALLBACK_LANGUAGE;
}
/** Normalizes a stored or session language; anything that is not a registered language is English. */
export function uiLocale(value: unknown): UiLanguage { return isUiLanguage(value) ? value : FALLBACK_LANGUAGE; }
export function setUiLanguage(value: UiLanguage): void { language = value; }
export function getUiLanguage(): UiLanguage { return language; }
export function t(key: TranslationKey, ...values: unknown[]): string {
  return translate(language, key, ...values);
}
export function translate(locale: ContentLanguage, key: TranslationKey, ...values: unknown[]): string {
  const entry = entryOf(locale);
  // An output-only language has no dictionary: it reads English.
  const selected: string | undefined = "dictionary" in entry ? entry.dictionary[key] : undefined;
  const translated = selected || en[key] || String(key);
  return translated.replace(/\{(\d+)\}/g, (_, index: string) => {
    const value = values[Number(index)];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : `{${index}}`;
  });
}

/**
 * Fixed text that is written into a note (`note.*`, `detail.*` keys). It is always spelled in the note language of
 * `locale`, so a note never gets an interface-only language; read it back with {@link isNoteLanguage}-checked values.
 */
export function translateNote(locale: ContentLanguage, key: TranslationKey, ...values: unknown[]): string {
  return translate(noteLanguageOf(locale), key, ...values);
}
/** {@link translateNote} for the current interface language. */
export function tNote(key: TranslationKey, ...values: unknown[]): string {
  return translateNote(language, key, ...values);
}

export function topicStatusLabel(status: "idea" | "running" | "completed" | "error", locale: UiLanguage): string {
  const keys: Record<typeof status, TranslationKey> = {
    idea: "ui.to_research",
    running: "ui.ai_running",
    completed: "ui.ai_complete",
    error: "ui.task_error"
  };
  return translate(locale, keys[status]);
}
