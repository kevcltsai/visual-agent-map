import {
  contentLocale,
  getUiLanguage,
  instructionLanguageOf,
  languagePromptName,
  translate,
  noteLanguageOf,
  uiLocale,
  type InstructionLanguage,
  type PromptNameForm,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";

/**
 * Language helpers for Coffee Tables. A session stores its language as the note language (zh-TW or en); everything
 * below derives what the prompts and the dialogue need from it, so no caller compares language ids.
 */

/** The prompt fragment set (`zh` or `en`) that instructs the AI for a session language. Unknown values read as English. */
export function coffeeInstruction(language: string): InstructionLanguage {
  return instructionLanguageOf(uiLocale(language));
}

/** The language the table speaks: the interface language when it shares the session's note language, else the note language. */
export function coffeeContentLocale(language: string): UiLanguage {
  return contentLocale(noteLanguageOf(uiLocale(language)), getUiLanguage());
}

/** How a prompt names the language the table speaks, spelled for the prompt's instruction language. */
export function coffeeLanguageName(language: string, form: PromptNameForm): string {
  return languagePromptName(coffeeContentLocale(language), coffeeInstruction(language), form);
}

/** Dictionary text in a session's language (the note language it is stored with); unknown values read as English. */
export function coffeeText(language: string, key: TranslationKey, ...values: unknown[]): string {
  return translate(uiLocale(language), key, ...values);
}
