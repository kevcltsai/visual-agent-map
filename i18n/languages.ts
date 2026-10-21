/**
 * The language registry: the single source of truth for every language VAM supports. Adding a language is one row here
 * plus one dictionary file; everything else (menus, locale lookups, prompt language names) reads this table.
 *
 * Four independent axes use it (see the multilingual plan, section 3):
 * - interface language (`UiLanguage`): the registry id, used for menus, notices and logs;
 * - note language (`NoteLanguage`): the language of fixed text written into notes, `note` below, only "zh-TW" or "en";
 * - instruction language (`InstructionLanguage`): which prompt fragment set (`zh` or `en`) the AI is instructed in;
 * - output content language: a `UiLanguage`, named inside prompts through `prompt`.
 */
export type InstructionLanguage = "zh" | "en";
/** Languages that fixed note text (headings, placeholders, relation labels) may be written in. */
export type NoteLanguage = "zh-TW" | "en";
/**
 * How a prompt names a language. `plain` is the bare name, `region` adds the regional variant, `usage` adds the usage
 * clause (used by the built-in Coffee Tables style). Each form exists in both instruction languages so a prompt reads
 * naturally whichever fragment set it lives in. The spellings are exactly those of the prompt files, which is what keeps
 * the zh-TW and en prompts byte-identical to the text they replaced.
 */
export type PromptNameForm = "plain" | "region" | "usage";
export type PromptNames = Readonly<Record<InstructionLanguage, Readonly<Record<PromptNameForm, string>>>>;

export interface LanguageEntry {
  /** Persisted interface-language value. */
  readonly id: string;
  /** The language's own name, shown in language menus. */
  readonly label: string;
  /** English name, used in AI prompts that are written in English around a language name. */
  readonly name: string;
  readonly instruction: InstructionLanguage;
  readonly note: NoteLanguage;
  /** BCP 47 tag for `Intl` and locale-sensitive formatting. */
  readonly intl: string;
  readonly prompt: PromptNames;
}

export const LANGUAGES = [
  {
    id: "zh-TW",
    label: "繁體中文",
    name: "Traditional Chinese",
    instruction: "zh",
    note: "zh-TW",
    intl: "zh-TW",
    prompt: {
      zh: { plain: "繁體中文", region: "繁體中文（台灣）", usage: "繁體中文（台灣用法）" },
      en: {
        plain: "Traditional Chinese",
        region: "Traditional Chinese (Taiwan)",
        usage: "Traditional Chinese (Taiwan usage)"
      }
    }
  },
  {
    id: "en",
    label: "English",
    name: "English",
    instruction: "en",
    note: "en",
    intl: "en",
    prompt: {
      zh: { plain: "英文", region: "英文", usage: "英文" },
      en: { plain: "English", region: "English", usage: "English" }
    }
  }
] as const satisfies ReadonlyArray<LanguageEntry>;

export type UiLanguage = (typeof LANGUAGES)[number]["id"];
