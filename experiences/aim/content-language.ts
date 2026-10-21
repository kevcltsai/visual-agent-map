import type { MapDocument } from "../../map-model";
import { contentLocale, isNoteLanguage, noteLanguageOf, type NoteLanguage, type UiLanguage } from "../../i18n";

const KANA_OR_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Character-only language detection for one piece of user text. "unsupported" means Japanese/Korean
 * (use the interface language); undefined means no decisive signal (empty, digits or emoji only). The script decides only
 * the note language (Han text is Chinese, Latin text English); {@link chooseAimContentLanguage} turns it into the
 * language to write in.
 */
export function detectAimContentLanguage(text: string): NoteLanguage | "unsupported" | undefined {
  if (KANA_OR_HANGUL.test(text)) return "unsupported";
  const han = (text.match(/\p{Script=Han}/gu) ?? []).length;
  const latin = (text.match(/\p{Script=Latin}+/gu) ?? []).length;
  if (han > 0 && han >= latin) return "zh-TW";
  if (latin > 0) return "en";
  return undefined;
}

/**
 * Picks the AIM content language from the user's own words: topic first, then context, then the
 * interface language. The detected script is a note language; it becomes the output language through
 * `contentLocale`, so a Simplified Chinese interface keeps writing Simplified Chinese for Chinese text. No AI call.
 */
export function chooseAimContentLanguage(uiLanguage: UiLanguage, ...sources: (string | undefined)[]): UiLanguage {
  for (const source of sources) {
    const result = detectAimContentLanguage(source ?? "");
    if (result === "unsupported") return uiLanguage;
    if (result) return contentLocale(result, uiLanguage);
  }
  return uiLanguage;
}

/**
 * Content language of a saved map: the stored value (a note language, read through `contentLocale`), else derived from the map title (legacy maps),
 * else the interface language. Read from the map on every call; never cached by callers.
 */
export function resolveAimContentLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): UiLanguage {
  const stored = map?.aim?.contentLanguage;
  if (isNoteLanguage(stored)) return contentLocale(stored, uiLanguage);
  return chooseAimContentLanguage(uiLanguage, map?.title);
}

/** The note language of {@link resolveAimContentLanguage}: what fixed text written into this map's notes uses. */
export function resolveAimNoteLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): NoteLanguage {
  return noteLanguageOf(resolveAimContentLanguage(map, uiLanguage));
}
