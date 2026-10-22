import { en, type TranslationKey } from "./en";
import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";

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
  /** The language's dictionary; keys it lacks fall back to English at lookup time. */
  readonly dictionary: Readonly<Partial<Record<TranslationKey, string>>>;
}

/**
 * Row order matters: the first row of each instruction family (`zh-TW` for `zh`, `en` for `en`) owns that family's
 * prompt snapshot tag (`.zh.`, `.en.`). A new row must not be placed before the existing first row of its instruction
 * family; appending at the end is always safe.
 */
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
    },
    dictionary: zhTW
  },
  {
    id: "zh-CN",
    label: "简体中文",
    name: "Simplified Chinese",
    instruction: "zh",
    note: "zh-TW",
    intl: "zh-CN",
    prompt: {
      // The region form names the Mainland standard (the counterpart of the Taiwan variant above); the usage form is the
      // Coffee Tables style clause, "usage" in the same sense as the Taiwan row.
      zh: { plain: "简体中文", region: "简体中文（中国大陆）", usage: "简体中文（中国大陆用法）" },
      en: {
        plain: "Simplified Chinese",
        region: "Simplified Chinese (Mainland China)",
        usage: "Simplified Chinese (Mainland China usage)"
      }
    },
    dictionary: zhCN
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
    },
    dictionary: en
  }
] as const satisfies ReadonlyArray<LanguageEntry>;

export type UiLanguage = (typeof LANGUAGES)[number]["id"];

/**
 * Script-based detection data for one output-only language: `script` must match, and `exclude` (when set) names letters
 * of a sibling language that share the script (Persian and Urdu write Arabic script), in which case there is no signal.
 */
export interface OutputLanguageDetection {
  readonly script: RegExp;
  readonly exclude?: RegExp;
  /**
   * An extra rule on the whole text once `script` matched (the Japanese kana rule, D-2026-10-86); when it says no, the
   * text gives no signal for this language and detection moves on.
   */
  readonly accept?: (text: string) => boolean;
}

/**
 * A language VAM can write AI content in but has no interface dictionary for. It is deliberately a separate table from
 * {@link LANGUAGES}: it adds no interface language, no prompt snapshot tag and no dictionary, so it needs no new
 * translations. Fixed text written into notes and the instruction language are always English. Rows with `detect` are
 * recognised from the map or topic text; the rest (Latin and Cyrillic scripts) are chosen by hand in the output
 * language menu, or reached through the `followsInput` row when the text has letters nothing recognises. A language that
 * gains a dictionary moves to {@link LANGUAGES}.
 */
export interface OutputLanguageEntry {
  readonly id: string;
  readonly label: string;
  readonly name: string;
  readonly instruction: "en";
  readonly note: "en";
  readonly intl: string;
  readonly prompt: PromptNames;
  readonly detect?: OutputLanguageDetection;
  /**
   * A virtual row, not a language: its prompt names are a clause that tells the model to write in the language of the
   * user's own text. It is chosen when the text has letters no row recognises (D-2026-10-83); it is never offered in
   * the image translation menu and is listed first, under its own label, in the output language menu.
   */
  readonly followsInput?: true;
}

/** Id of the "same language as the user's text" virtual row of {@link OUTPUT_LANGUAGES}. */
export const FOLLOW_INPUT_ID = "same-as-input";

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/gu;
/**
 * Whether kana in `text` mean Japanese (D-2026-10-86): at least two kana other than the particle の (which Chinese
 * titles borrow, as in 台灣の旅), and kana plus Han make up at least twice the number of Latin words, so a Latin
 * sentence that quotes a katakana word is not Japanese.
 */
const japaneseKanaRule = (text: string): boolean => {
  const kana = text.match(KANA) ?? [];
  if (kana.filter(char => char !== "の").length < 2) return false;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latinWords = (text.match(/\p{Script=Latin}+/gu) ?? []).length;
  return kana.length + han >= 2 * latinWords;
};

/** Prompt names are the same in all three forms: these languages have no regional or usage variants. */
const names = (zh: string, en: string): PromptNames => ({
  zh: { plain: zh, region: zh, usage: zh },
  en: { plain: en, region: en, usage: en }
});

/** Order is menu order; detection tries rows in this order, so kana (Japanese) is tested before anything else. */
export const OUTPUT_LANGUAGES = [
  {
    id: "ja",
    label: "日本語",
    name: "Japanese",
    instruction: "en",
    note: "en",
    intl: "ja",
    prompt: names("日文", "Japanese"),
    detect: { script: /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/u, accept: japaneseKanaRule }
  },
  {
    id: "ko",
    label: "한국어",
    name: "Korean",
    instruction: "en",
    note: "en",
    intl: "ko",
    prompt: names("韓文", "Korean"),
    detect: { script: /\p{Script=Hangul}/u }
  },
  {
    id: "es",
    label: "Español",
    name: "Spanish",
    instruction: "en",
    note: "en",
    intl: "es",
    prompt: names("西班牙文", "Spanish")
  },
  {
    id: "fr",
    label: "Français",
    name: "French",
    instruction: "en",
    note: "en",
    intl: "fr",
    prompt: names("法文", "French")
  },
  {
    id: "de",
    label: "Deutsch",
    name: "German",
    instruction: "en",
    note: "en",
    intl: "de",
    prompt: names("德文", "German")
  },
  {
    id: "pt",
    label: "Português",
    name: "Portuguese",
    instruction: "en",
    note: "en",
    intl: "pt",
    prompt: names("葡萄牙文", "Portuguese")
  },
  {
    id: "ru",
    label: "Русский",
    name: "Russian",
    instruction: "en",
    note: "en",
    intl: "ru",
    prompt: names("俄文", "Russian")
  },
  {
    id: "ar",
    label: "العربية",
    name: "Arabic",
    instruction: "en",
    note: "en",
    intl: "ar",
    prompt: names("阿拉伯文", "Arabic"),
    // Persian and Urdu share the script; their own letters mean the text is not Arabic.
    detect: { script: /\p{Script=Arabic}/u, exclude: /[پچژگکیٹڈڑںے]/u }
  },
  {
    id: "th",
    label: "ไทย",
    name: "Thai",
    instruction: "en",
    note: "en",
    intl: "th",
    prompt: names("泰文", "Thai"),
    detect: { script: /\p{Script=Thai}/u }
  },
  {
    id: "vi",
    label: "Tiếng Việt",
    name: "Vietnamese",
    instruction: "en",
    note: "en",
    intl: "vi",
    prompt: names("越南文", "Vietnamese"),
    // Letters only Vietnamese uses: ơ, ư and the stacked-diacritic block U+1EA0-1EF9. A lone đ or ă also occurs elsewhere.
    detect: { script: /[ơưƠƯ\u{1EA0}-\u{1EF9}]/u }
  },
  {
    id: FOLLOW_INPUT_ID,
    label: "Same as input",
    name: "Same as input",
    instruction: "en",
    note: "en",
    intl: "en",
    followsInput: true,
    prompt: {
      zh: {
        plain: "與使用者自己輸入的文字（主題、問題或選取文字）相同的語言",
        region: "與使用者自己輸入的文字（主題、問題或選取文字）相同的語言",
        usage: "與使用者自己輸入的文字（主題、問題或選取文字）相同的語言"
      },
      en: {
        plain: "the same language as the user's own text (topic, question or selection)",
        region: "the same language as the user's own text (topic, question or selection)",
        usage: "the same language as the user's own text (topic, question or selection)"
      }
    }
  }
] as const satisfies ReadonlyArray<OutputLanguageEntry>;

export type OutputOnlyId = (typeof OUTPUT_LANGUAGES)[number]["id"];
