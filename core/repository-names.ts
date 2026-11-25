import { tNote } from "../i18n";

const SAFE_NAME_LIMIT = 80;

type GraphemeSegmenter = new (
  locale?: string,
  options?: { granularity: "grapheme" }
) => { segment(input: string): Iterable<{ segment: string }> };

/** Splits text into grapheme clusters (code points when `Intl.Segmenter` is unavailable). */
function graphemes(value: string): string[] {
  const Segmenter = (Intl as { Segmenter?: GraphemeSegmenter }).Segmenter;
  if (Segmenter)
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(value), part => part.segment);
  return Array.from(value);
}

/**
 * A file or folder name for a NEW note or map. Never applied to existing paths (a stored path is never renamed).
 * Cuts at 80 UTF-16 units on a grapheme boundary, and never leaves a leading dot (hidden file) or a trailing dot or space.
 */
export function safeName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "");
  let cut = cleaned;
  if (cleaned.length > SAFE_NAME_LIMIT) {
    cut = "";
    for (const part of graphemes(cleaned)) {
      if (cut.length + part.length > SAFE_NAME_LIMIT) break;
      cut += part;
    }
  }
  return cut.replace(/[\s.]+$/, "") || tNote("note.untitled_topic");
}

/** Case- and form-insensitive name used to detect a collision on a case-insensitive file system. */
function foldName(value: string): string {
  return value.normalize("NFC").toLowerCase().replace(/ς/g, "σ");
}

/** Folds a file name without its extension, so a final sigma before ".md" folds as it does inside the name. */
export function foldEntryName(name: string, isFile: boolean): string {
  const dot = isFile ? name.lastIndexOf(".") : -1;
  return dot > 0 ? `${foldName(name.slice(0, dot))}.${name.slice(dot + 1).toLowerCase()}` : foldName(name);
}

/** A link alias safe inside `[[path|alias]]` and a YAML list item: no brackets, pipe, backtick or line breaks. */
export function linkAlias(title: string, fallback: string): string {
  const alias = title
    .replace(/[[\]|`\r\n]/g, " ")
    .replace(/%{2,}/g, "%")
    .replace(/\s+/g, " ")
    .trim();
  return alias || fallback;
}
