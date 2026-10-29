import type { MapDocument } from "../../map-model";
import {
  contentLocale,
  FOLLOW_INPUT_ID,
  isContentLanguage,
  isFollowInputLanguage,
  isNoteLanguage,
  noteLanguageOf,
  NOTE_LANGUAGES,
  OUTPUT_LANGUAGES,
  translate,
  type ContentLanguage,
  type NoteLanguage,
  type OutputLanguageEntry,
  type OutputOnlyId,
  type TranslationKey,
  type UiLanguage
} from "../../i18n";
import { hanScriptVotes } from "../../i18n/han-fold";
import { LATIN_TEXT_DETECTION } from "../../i18n/languages";

/**
 * What {@link detectAimContentLanguage} can name: an output-only language (including the follow-the-input row), a Han
 * script (Traditional or Simplified), or plain English.
 */
export type DetectedLanguage = OutputOnlyId | "zh-TW" | "zh-CN" | typeof LATIN_TEXT_DETECTION.language;

const OUTPUT_ROWS: ReadonlyArray<OutputLanguageEntry> = OUTPUT_LANGUAGES;

/** True for an output-only language id (never an interface language); persisted values are checked with this. */
export const isOutputOnlyLanguage = (value: unknown): value is OutputOnlyId =>
  OUTPUT_LANGUAGES.some(item => item.id === value);

/** Han text whose characters do not settle the script (shared characters only, or a tie): the interface decides. */
const UNDECIDED_HAN = "han";
type Signal = DetectedLanguage | typeof UNDECIDED_HAN;

/**
 * The part of `text` that is the user's own words (0.28 ticket 06): fenced code blocks (an unclosed fence is kept),
 * inline code, Markdown images and links (title and URL) and bare URLs (ASCII only, so Chinese written right after a URL stays) are
 * removed. Wiki links keep their text. When
 * nothing with a letter is left, the original text is used, so a lone link title still has a signal.
 */
function detectionText(text: string): string {
  const cleaned = text
    .replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\1[`~]*[ \t]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, "")
    .replace(/https?:\/\/[\x21-\x7E]+/g, "");
  return /\p{L}/u.test(cleaned) ? cleaned : text;
}

/**
 * The language signal of one piece of text, from letters only (no AI call), after {@link detectionText} has removed
 * links, images, URLs and code:
 * 1. output-only languages with a script of their own, from the `detect` data of the language table in row order (kana
 *    after the kana rule: enough kana, and a share of kana among kana and Han; hangul, Arabic script without Persian or Urdu letters, Thai, Vietnamese letters);
 * 2. Han text (at least as many Han characters as Latin words) is Chinese: Simplified or Traditional when the characters
 *    decide it, otherwise {@link UNDECIDED_HAN};
 * 3. plain English: every letter is ASCII, at least one English function word and no foreign one (see
 *    {@link englishByFunctionWords}), so the output is named exactly instead of by a follow-the-input clause;
 * 4. any other letters (Latin, Cyrillic, Greek, Hebrew, Persian or Urdu Arabic) cannot be told apart reliably, so the
 *    answer is the follow-the-input row: the model writes in the language of the text;
 * 5. undefined when there is no letter at all (empty, digits, emoji).
 */
function signalOf(source: string): Signal | undefined {
  const text = detectionText(source);
  for (const entry of OUTPUT_ROWS) {
    const detect = entry.detect;
    if (!detect || !detect.script.test(text) || detect.exclude?.test(text)) continue;
    if (detect.accept && !detect.accept(text)) continue;
    return entry.id as OutputOnlyId;
  }
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}+/gu) ?? []).length;
  if (han > 0 && han >= latin) {
    const votes = hanScriptVotes(text);
    if (votes.simplified > votes.traditional) return "zh-CN";
    if (votes.traditional > votes.simplified) return "zh-TW";
    return UNDECIDED_HAN;
  }
  if (englishByFunctionWords(text)) return LATIN_TEXT_DETECTION.language;
  if (/\p{L}/u.test(text)) return FOLLOW_INPUT_ID;
  return undefined;
}

/**
 * Whether `text` is plain English (D-2026-10-94): all its letters are ASCII, and by the function-word data of
 * {@link LATIN_TEXT_DETECTION} it has an English function word and no foreign one. Text with accents, or with no function
 * word either way ("Ancient Egypt"), is not decided here.
 */
function englishByFunctionWords(text: string): boolean {
  if (/\p{L}/u.test(text.replace(/[A-Za-z]/g, ""))) return false;
  const words = text.toLowerCase().match(/[a-z]+/g) ?? [];
  const english: readonly string[] = LATIN_TEXT_DETECTION.words;
  const foreign: readonly string[] = LATIN_TEXT_DETECTION.foreign;
  return words.some(word => english.includes(word)) && !words.some(word => foreign.includes(word));
}

/**
 * Character-only language detection for one piece of user text. Undefined means no letters at all. Han text with no
 * decisive characters reads as Traditional here; {@link chooseAimContentLanguage} lets the interface language decide
 * that case instead.
 */
export function detectAimContentLanguage(text: string): DetectedLanguage | undefined {
  const signal = signalOf(text);
  if (signal === UNDECIDED_HAN) return "zh-TW";
  return signal;
}

/**
 * Picks the output language from the user's own words: the first source (topic first, then context) with any letters
 * decides. A language the letters settle (ja, ko, ar, th, vi, Simplified or Traditional characters) is used as is;
 * Han text that settles nothing follows the interface (a Simplified Chinese interface keeps writing Simplified
 * Chinese); text with letters nothing recognises (Latin, Cyrillic...) gets the follow-the-input row; no letters in any
 * source gives the interface language. No AI call. A manual choice and a map's remembered language rank above this and
 * are applied by the callers.
 */
export function chooseAimContentLanguage(uiLanguage: UiLanguage, ...sources: (string | undefined)[]): ContentLanguage {
  for (const source of sources) {
    const signal = signalOf(source ?? "");
    if (signal === undefined) continue;
    if (signal === UNDECIDED_HAN) return contentLocale("zh-TW", uiLanguage);
    return signal;
  }
  return uiLanguage;
}

/** The language to write in for a piece of selected text; same rule as {@link chooseAimContentLanguage}. */
export function selectionOutputLanguage(uiLanguage: UiLanguage, selected: string): ContentLanguage {
  return chooseAimContentLanguage(uiLanguage, selected);
}

/** The standard Detail heading keys: a note carrying one of them in a language's spelling was written in that language. */
const STANDARD_HEADING_KEYS: readonly TranslationKey[] = [
  "detail.core_conclusions",
  "detail.key_knowledge",
  "detail.evidence_and_sources",
  "detail.tradeoffs_and_limitations",
  "detail.open_questions",
  "detail.update_log"
];

/**
 * The note language a note body was written in, read from its standard Detail headings (copied from the zh-TW and en
 * dictionaries). Undefined when no heading is found or the body mixes both spellings. A note without a stored
 * `content-language` (0.24 and earlier general tasks) is only identifiable this way.
 */
export function noteLanguageFromBody(body: string | undefined): NoteLanguage | undefined {
  if (!body) return undefined;
  const headings = new Set(
    body
      .split(/\r?\n/)
      .map(line => /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
      .filter((heading): heading is string => heading !== undefined)
  );
  const found = NOTE_LANGUAGES.filter(language =>
    STANDARD_HEADING_KEYS.some(key => headings.has(translate(language, key)))
  );
  return found.length === 1 ? found[0] : undefined;
}

/** The stored language of a note: its `content-language`, else the language of its standard headings (D-2026-10-84). */
export function existingNoteLanguage(note: {
  contentLanguage?: NoteLanguage;
  detail?: string;
}): NoteLanguage | undefined {
  return note.contentLanguage ?? noteLanguageFromBody(note.detail);
}

/**
 * The output language a task dialog preselects. Order: the map's remembered choice, then detection from the topic text.
 * A detected language whose fixed text would be written in another note language than the note already uses (L1, D-84:
 * a Traditional Chinese note on a Japanese card) falls back to the interface language, the previous default.
 */
export function defaultOutputLanguage(
  ui: UiLanguage,
  topic: string,
  noteLanguage?: NoteLanguage,
  remembered?: unknown
): ContentLanguage {
  if (isContentLanguage(remembered)) return remembered;
  const chosen = chooseAimContentLanguage(ui, topic);
  if (noteLanguage !== undefined && noteLanguageOf(chosen) !== noteLanguage) return ui;
  return chosen;
}

/** A map's remembered output language (D-2026-10-88), or undefined when it has none or the stored value is unknown. */
export function rememberedOutputLanguage(
  map: Pick<MapDocument, "outputLanguage"> | undefined | null
): ContentLanguage | undefined {
  const value: unknown = map?.outputLanguage;
  return isContentLanguage(value) ? value : undefined;
}

/**
 * Output language of a saved map, read from the map on every call (never cached by callers):
 * 1. the map's `outputLanguage` (chosen by hand, or recorded when an AIM map was created), when it is a known id;
 *    unknown values are ignored;
 * 2. the stored AIM `contentLanguage` (a note language, read through `contentLocale`); a map written before output-only
 *    languages existed stored "en" for a Japanese title, so when the title now detects a recognised output-only
 *    language whose note language equals the stored value, that language is used (a map created in a Chinese
 *    interface keeps Chinese);
 * 3. otherwise derived from the map title, then the interface language.
 */
export function resolveAimContentLanguage(
  map: Pick<MapDocument, "title" | "aim" | "outputLanguage"> | undefined | null,
  uiLanguage: UiLanguage
): ContentLanguage {
  const remembered = rememberedOutputLanguage(map);
  if (remembered !== undefined) return remembered;
  const stored = map?.aim?.contentLanguage;
  if (isNoteLanguage(stored)) {
    const detected = detectAimContentLanguage(map?.title ?? "");
    if (
      detected !== undefined &&
      isOutputOnlyLanguage(detected) &&
      !isFollowInputLanguage(detected) &&
      noteLanguageOf(detected) === stored
    )
      return detected;
    return contentLocale(stored, uiLanguage);
  }
  return chooseAimContentLanguage(uiLanguage, map?.title);
}

/**
 * The language for a map-level AI run with no dialog (outline draft, structure review, relevance grading): the map's
 * remembered choice (D-2026-10-88), else detected from the user's own text in `sources`, else the interface language.
 */
export function outputLanguageForMap(
  map: Pick<MapDocument, "outputLanguage"> | undefined | null,
  uiLanguage: UiLanguage,
  ...sources: (string | undefined)[]
): ContentLanguage {
  return rememberedOutputLanguage(map) ?? chooseAimContentLanguage(uiLanguage, ...sources);
}

/**
 * The text sources the map chat reads the output language from (0.28 ticket 07, decision
 * 2026-10-30-map-chat-instruction-language#1). The instruction is the first paragraph: the text before the first blank
 * line (a line with only whitespace; `\n` and `\r\n` both count), when more text follows it. Returns
 * `[instruction, whole message]`, so {@link chooseAimContentLanguage} takes the first source with letters: what the user
 * typed decides, and a long paste after it is only read when the instruction has no letters (symbols, digits, emoji).
 * A message with no blank line, or with nothing after it, is all the user's own words: `[whole message]`.
 */
export function mapChatLanguageSources(message: string): string[] {
  const boundary = /(?:\r?\n)[ \t]*(?:\r?\n)/.exec(message);
  if (!boundary) return [message];
  const instruction = message.slice(0, boundary.index);
  const rest = message.slice(boundary.index + boundary[0].length);
  if (!/\S/.test(rest)) return [message];
  return [instruction, message];
}

/**
 * The language a map's AI output and map-level text follow, as a `ContentLanguage`: the single function other code
 * (default names, labels) calls to learn what the map is written in. Same rule as {@link resolveAimContentLanguage}.
 */
export const resolveMapOutputLanguage = resolveAimContentLanguage;

/** The note language of {@link resolveAimContentLanguage}: what fixed text written into this map's notes uses. */
export function resolveAimNoteLanguage(
  map: Pick<MapDocument, "title" | "aim" | "outputLanguage"> | undefined | null,
  uiLanguage: UiLanguage
): NoteLanguage {
  return noteLanguageOf(resolveAimContentLanguage(map, uiLanguage));
}
