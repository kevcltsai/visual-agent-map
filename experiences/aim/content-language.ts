import type { MapDocument } from "../../map-model";
import {
  contentLocale,
  isNoteLanguage,
  noteLanguageOf,
  OUTPUT_LANGUAGES,
  type ContentLanguage,
  type NoteLanguage,
  type OutputLanguageEntry,
  type OutputOnlyId,
  type UiLanguage
} from "../../i18n";

/** What {@link detectAimContentLanguage} can name: a note language (Han or Latin text) or an output-only language. */
export type DetectedLanguage = NoteLanguage | OutputOnlyId;

const OUTPUT_ROWS: ReadonlyArray<OutputLanguageEntry> = OUTPUT_LANGUAGES;

/** True for an output-only language id (never an interface language); persisted values are checked with this. */
export const isOutputOnlyLanguage = (value: unknown): value is OutputOnlyId =>
  OUTPUT_LANGUAGES.some(item => item.id === value);

/**
 * Character-only language detection for one piece of user text. Output-only languages with a script of their own are
 * matched first, from the `detect` data of the language table (kana before Han, so Japanese text with kanji is
 * Japanese); then Han text is Chinese and Latin text English. Undefined means no decisive signal (empty, digits or
 * emoji only, or Arabic script with Persian or Urdu letters). {@link chooseAimContentLanguage} turns the result into
 * the language to write in.
 */
export function detectAimContentLanguage(text: string): DetectedLanguage | undefined {
  for (const entry of OUTPUT_ROWS) {
    if (!entry.detect || !entry.detect.script.test(text)) continue;
    return entry.detect.exclude?.test(text) ? undefined : (entry.id as OutputOnlyId);
  }
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}+/gu) ?? []).length;
  if (han > 0 && han >= latin) return "zh-TW";
  if (latin > 0) return "en";
  return undefined;
}

/**
 * Picks the AIM content language from the user's own words: topic first, then context, then the
 * interface language. A detected note language becomes the output language through `contentLocale`, so a Simplified
 * Chinese interface keeps writing Simplified Chinese for Chinese text; a detected output-only language is used as is.
 * No AI call.
 */
export function chooseAimContentLanguage(uiLanguage: UiLanguage, ...sources: (string | undefined)[]): ContentLanguage {
  for (const source of sources) {
    const result = detectAimContentLanguage(source ?? "");
    if (result === undefined) continue;
    return isNoteLanguage(result) ? contentLocale(result, uiLanguage) : result;
  }
  return uiLanguage;
}

/**
 * The language to write in for a piece of selected text: an output-only language when the text is written in one,
 * otherwise the interface language (so a registry language keeps following the interface, as before).
 */
export function selectionOutputLanguage(uiLanguage: UiLanguage, selected: string): ContentLanguage {
  const detected = detectAimContentLanguage(selected);
  return isOutputOnlyLanguage(detected) ? detected : uiLanguage;
}

/**
 * Content language of a saved map, read from the map on every call (never cached by callers):
 * 1. `aim.outputLanguage` (an output-only language chosen at creation), when it is a known id; unknown values are ignored;
 * 2. the stored `contentLanguage` (a note language, read through `contentLocale`); a map written before output-only
 *    languages existed stored "en" for a Japanese title, so when the title now detects an output-only language whose
 *    note language equals the stored value, that language is used (a map created in a Chinese interface keeps Chinese);
 * 3. otherwise derived from the map title (legacy maps), then the interface language.
 */
export function resolveAimContentLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): ContentLanguage {
  const output = map?.aim?.outputLanguage;
  if (isOutputOnlyLanguage(output)) return output;
  const stored = map?.aim?.contentLanguage;
  if (isNoteLanguage(stored)) {
    const detected = detectAimContentLanguage(map?.title ?? "");
    if (detected !== undefined && !isNoteLanguage(detected) && noteLanguageOf(detected) === stored) return detected;
    return contentLocale(stored, uiLanguage);
  }
  return chooseAimContentLanguage(uiLanguage, map?.title);
}

/** The note language of {@link resolveAimContentLanguage}: what fixed text written into this map's notes uses. */
export function resolveAimNoteLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): NoteLanguage {
  return noteLanguageOf(resolveAimContentLanguage(map, uiLanguage));
}
