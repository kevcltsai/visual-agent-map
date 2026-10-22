import type { MapDocument } from "../../map-model";
import { isUiLanguage, translate, uiLocale, type ContentLanguage, type UiLanguage } from "../../i18n";
import { detectAimContentLanguage, resolveAimContentLanguage } from "../aim/content-language";

/**
 * "Map text language": the registry language (an interface language with a dictionary) that fixed text VAM makes up for
 * a map uses, such as the default name of a synthesis or the suffix of a copied note. Output-only languages and any
 * unknown value have no dictionary, so their fixed text is English (the registry fallback).
 */
export function mapTextLanguage(language: ContentLanguage | undefined): UiLanguage {
  return isUiLanguage(language) ? language : uiLocale(undefined);
}

/**
 * HOOK (D-2026-10-88/89): the one place that names the language a map is in. It delegates to
 * {@link resolveAimContentLanguage}, which is where a map-level `outputLanguage` is read once the map model has the
 * field; extend that resolver (or this function) and every fixed-text caller follows. Read on every call, never cached.
 */
export function mapContentLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): ContentLanguage {
  return resolveAimContentLanguage(map, uiLanguage);
}

/** The map text language of a map (see {@link mapTextLanguage}). */
export function resolveMapTextLanguage(
  map: Pick<MapDocument, "title" | "aim"> | undefined | null,
  uiLanguage: UiLanguage
): UiLanguage {
  return mapTextLanguage(mapContentLanguage(map, uiLanguage));
}

/**
 * The language of one piece of text such as a note title, as a registry language; `fallback` when the text has no
 * decisive signal (digits, emoji, empty). Output-only scripts read English, like {@link mapTextLanguage}.
 */
export function textLanguageOf(text: string, fallback: UiLanguage): UiLanguage {
  const detected = detectAimContentLanguage(text);
  return detected === undefined ? fallback : mapTextLanguage(detected);
}

/**
 * Default name of a synthesis in `language`: up to two source names joined, otherwise the first name and the count, so
 * the name stays short however many topics are selected (FG20-29).
 */
export function synthesisDefaultName(language: UiLanguage, names: readonly string[]): string {
  return names.length > 2
    ? translate(language, "ui.synthesis_of_0_and_1_more", names[0], names.length)
    : translate(language, "ui.synthesis_of_0", names.join(translate(language, "ui.list_separator")));
}
