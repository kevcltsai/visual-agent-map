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
  /**
   * Only on the follow-the-input row: the clause naming the user's own text instead of describing it, so the model finds
   * the text to follow even when it is written in the language of the instructions. `{kind}` is one of
   * {@link FOLLOW_ANCHOR_KINDS}, `{anchor}` the quoted text itself.
   */
  readonly anchored?: Readonly<Record<InstructionLanguage, string>>;
}

/** What the quoted anchor of the follow-the-input clause is: the card's topic, an AIM or review question, or selected text. */
export type FollowAnchorKind = "topic" | "question" | "selection";
/** The anchor of the follow-the-input clause: the user's own words the model must answer in the language of. */
export interface FollowAnchor {
  readonly kind: FollowAnchorKind;
  readonly text: string;
}
/** How each anchor kind is spelled in the clause of each instruction language. */
export const FOLLOW_ANCHOR_KINDS: Readonly<Record<FollowAnchorKind, Readonly<Record<InstructionLanguage, string>>>> = {
  topic: { zh: "主題", en: "topic" },
  question: { zh: "問題", en: "question" },
  selection: { zh: "選取文字", en: "selected text" }
};
/** Longest anchor quoted in a prompt, in characters; longer text is cut and ends with an ellipsis. */
export const FOLLOW_ANCHOR_MAX = 80;

/** Id of the "same language as the user's text" virtual row of {@link OUTPUT_LANGUAGES}. */
export const FOLLOW_INPUT_ID = "same-as-input";

const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/gu;
/**
 * Smallest share of kana among kana plus Han for Japanese (0.28 ticket 06, decision 2026-10-30-language-detect-ratio#1):
 * Chinese text that quotes a little Japanese (a link title, a katakana word, ー as a dash) stays far below it, a Japanese
 * sentence stays above.
 */
const JAPANESE_KANA_SHARE = 0.25;
/**
 * Whether kana in `text` mean Japanese (D-2026-10-86): at least two kana other than the particle の (which Chinese
 * titles borrow, as in 台灣の旅), kana plus Han make up at least twice the number of Latin words, so a Latin sentence
 * that quotes a katakana word is not Japanese, and kana are at least {@link JAPANESE_KANA_SHARE} of kana plus Han, so a
 * long Chinese text with a few Japanese words is not Japanese either.
 */
const japaneseKanaRule = (text: string): boolean => {
  const kana = text.match(KANA) ?? [];
  if (kana.filter(char => char !== "の").length < 2) return false;
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latinWords = (text.match(/\p{Script=Latin}+/gu) ?? []).length;
  return kana.length + han >= 2 * latinWords && kana.length / (kana.length + han) >= JAPANESE_KANA_SHARE;
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
    // Without an anchor (no text to quote) the clause can only describe the text.
    prompt: names(
      "使用者自己輸入的文字（主題、問題或選取文字）所使用的語言（不是這些指示或固定標題的語言）",
      "the language in which the user's own text (topic, question or selection) is written (not the language of these instructions or of the fixed headings)"
    ),
    anchored: {
      zh: "使用者的{kind}「{anchor}」所使用的語言（不是這些指示或固定標題的語言）",
      en: 'the language in which the user\'s {kind} "{anchor}" is written (not the language of these instructions or of the fixed headings)'
    }
  }
] as const satisfies ReadonlyArray<OutputLanguageEntry>;

export type OutputOnlyId = (typeof OUTPUT_LANGUAGES)[number]["id"];

/** Splits a space-separated word list (one line per language keeps the table readable). */
const words = (list: string): readonly string[] => list.split(" ");

/**
 * Function-word data that tells plain English from other Latin-script text when letters alone cannot (D-2026-10-94).
 * Text whose letters are all ASCII, with at least one `words` entry and no `foreign` entry, is the language `language`;
 * anything else stays on the follow-the-input row. The comparison is on whole lower-cased words.
 *
 * Shared words are in neither list: a, in, no, on (French "on"), an, as, at, per, plus, par, van, met, op, was, am, fur,
 * os, med, si, den, and the words that are also common in English text or names: do, die, come (Italian), et (Smith et al.), mit (MIT), los (Los Angeles), la, lo, non (non-profit), da (Da Vinci), des (Des Moines), al (Al Gore, Spanish "al" beside English), ve (the "ve" of we've). A word that is plainly a foreign function word goes in `foreign` even when a rare English homograph exists
 * (con, em, um), because a wrong "English" costs more than a missed one: a missed one only keeps
 * the model following the input text. Dutch "is" is covered by the Dutch words beside it in `foreign`.
 */
export const LATIN_TEXT_DETECTION = {
  language: "en",
  words: words(
    "the of and to for how what is are with why when from your my this that these those which who where you we they it be can will would should not if than there their about into between have does our its"
  ),
  foreign: words(
    // Spanish
    "de el las del un una uno que por para con se es su sus como y mas entre sobre" +
      " " +
      // French
      "le les du est sont pour avec dans sur au aux cette ces qui pas ne sans vers chez comme mais ou une je tu nous vous" +
      " " +
      // German
      "der das und ist von zu dem ein eine einer nicht auf aus bei nach wie oder wir im zum zur ich sie als auch aber wenn wer" +
      " " +
      // Portuguese
      "dos em um uma nao na nas pelo pela sao ao aos" +
      " " +
      // Italian
      "il gli di della dei delle dello degli che sono nel nella anche alla" +
      " " +
      // Dutch
      "het een voor aan naar ook dit dat maar zijn wat hoe waarom ik wij niet uit bij om" +
      " " +
      // Scandinavian
      "och att det som inte jeg ikke hvordan og" +
      " " +
      // Indonesian and Turkish
      "yang dan untuk dengan dari tidak adalah pada apa bagaimana bir icin ile nasil neden" +
      " " +
      // Polish, Czech and Romanian
      "jest nie dla jak czy oraz pentru este"
  )
} as const;
