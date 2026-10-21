import { en, type TranslationKey } from "./i18n/en";
import { zhTW } from "./i18n/zh-TW";
import {
  LANGUAGES,
  type InstructionLanguage,
  type LanguageEntry,
  type NoteLanguage,
  type PromptNameForm,
  type UiLanguage
} from "./i18n/languages";

export type { InstructionLanguage, NoteLanguage, PromptNameForm, TranslationKey, UiLanguage };
export { LANGUAGES };

/** Dictionaries by language id. A language missing a key falls back to English (`translate`). */
const DICTIONARIES: Record<UiLanguage, Readonly<Partial<Record<TranslationKey, string>>>> = { "zh-TW": zhTW, en };

const registry: ReadonlyArray<LanguageEntry> = LANGUAGES;
/** The interface language used when a stored or requested language is not registered. */
const FALLBACK_LANGUAGE: UiLanguage = "en";
const entryOf = (locale: UiLanguage): LanguageEntry =>
  registry.find(item => item.id === locale) ?? registry.find(item => item.id === FALLBACK_LANGUAGE)!;

/** Every language fixed note text can be written in (the registry's distinct `note` values), in registry order. */
export const NOTE_LANGUAGES: readonly NoteLanguage[] = [...new Set(registry.map(item => item.note))];

/**
 * Every language VAM supports, in menu order. Language menus (settings, output language, image translation) read
 * this list, so a newly supported language appears in all of them. `name` is the English name used in AI prompts.
 */
export const SUPPORTED_LANGUAGES: ReadonlyArray<{ id: UiLanguage; label: string; name: string }> = LANGUAGES.map(({ id, label, name }) => ({ id, label, name }));
export function supportedLanguageLabel(id: string): string {
  return SUPPORTED_LANGUAGES.find(item => item.id === id)?.label ?? id;
}

/** True for a registered interface-language id. */
export function isUiLanguage(value: unknown): value is UiLanguage {
  return registry.some(item => item.id === value);
}
/** True for a language that fixed note text can be written in; use this for persisted values read back from notes and maps. */
export function isNoteLanguage(value: unknown): value is NoteLanguage {
  return isUiLanguage(value) && entryOf(value).note === value;
}
/** The language fixed note text is written in when the interface is `locale`. */
export function noteLanguageOf(locale: UiLanguage): NoteLanguage { return entryOf(locale).note; }
/** The prompt fragment set (`zh` or `en`) used to instruct the AI when the interface is `locale`. */
export function instructionLanguageOf(locale: UiLanguage): InstructionLanguage { return entryOf(locale).instruction; }
/**
 * The language to name as the output content language: the interface language when its note language equals `note`
 * (so a Simplified Chinese interface keeps writing Simplified Chinese prose), otherwise `note` itself.
 */
export function contentLocale(note: NoteLanguage, ui: UiLanguage): UiLanguage { return noteLanguageOf(ui) === note ? ui : note; }
/** How a prompt written in `instruction` names language `locale`, in the given `form`. */
export function languagePromptName(locale: UiLanguage, instruction: InstructionLanguage, form: PromptNameForm): string {
  return entryOf(locale).prompt[instruction][form];
}
/** BCP 47 tag for `Intl` formatting of `locale`. */
export function intlLocaleOf(locale: UiLanguage): string { return entryOf(locale).intl; }

let language: UiLanguage = FALLBACK_LANGUAGE;
/** The saved interface language, or English when absent, invalid, or written by a newer version. */
export function initialUiLanguage(saved: unknown): UiLanguage {
  return isUiLanguage(saved) ? saved : FALLBACK_LANGUAGE;
}
/** Normalizes a stored or session language; anything that is not a registered language is English. */
export function uiLocale(value: unknown): UiLanguage { return isUiLanguage(value) ? value : FALLBACK_LANGUAGE; }
export function setUiLanguage(value: UiLanguage): void { language = value; }
export function getUiLanguage(): UiLanguage { return language; }
export function t(key: TranslationKey, ...values: unknown[]): string {
  return translate(language, key, ...values);
}
export function translate(locale: UiLanguage, key: TranslationKey, ...values: unknown[]): string {
  const selected: string | undefined = DICTIONARIES[locale]?.[key];
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
export function translateNote(locale: UiLanguage, key: TranslationKey, ...values: unknown[]): string {
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
