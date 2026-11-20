/**
 * Does a picture file fit its slot? Deterministic word overlap between what the file says about itself (title, description,
 * categories) and what the slot asks for (the plan's line, the finder's subject and English search words). No model call.
 */
import { slotKeywords } from "./image-slots";

/** What the slot asks for: its line in the book's language, the planner's English search terms, and the finder's subject and English search words. */
export interface SlotAsk {
  explains: string;
  /** The planner's English search terms (the card plan's slot field). */
  terms?: readonly string[];
  subject?: string;
  search?: string;
}

/** A Latin word without a plain plural ending (`pots` → `pot`, `berries` → `berry`, `leaves` → `leaf`, `tomatoes` → `tomato`); Han pairs stay as they are. */
const stem = (word: string): string =>
  /^[a-z]/.test(word) && word.length > 3
    ? word
        .replace(/ies$/, "y")
        .replace(/(lea|[lr])ves$/, "$1f")
        .replace(/(ch|sh|x|ss|o)es$/, "$1")
        .replace(/([^s])s$/, "$1")
    : word;

/** The words a slot asks for (stemmed, no duplicates). */
export function askWords(ask: SlotAsk): string[] {
  return [
    ...new Set(
      [ask.explains, ...(ask.terms ?? []), ask.subject, ask.search].flatMap(text => slotKeywords(text ?? "")).map(stem)
    )
  ];
}

/** How many of `words` the text has: a Latin word as a whole (stemmed) word, a Han pair anywhere. */
export function wordHits(words: readonly string[], text: string): number {
  const lower = text.toLowerCase().replace(/_/g, " ");
  const own = new Set((lower.match(/[a-z0-9][a-z0-9'-]*/g) ?? []).map(stem));
  return words.filter(word => (/^[a-z0-9]/.test(word) ? own.has(word) : lower.includes(word))).length;
}

/** The slot asks for a photograph (its kind line says so). */
const PHOTO_KIND = /photo|照片|相片|實拍|实拍|攝影|摄影|写真/i;
const MAP_KIND = /\bmaps?\b|地圖|地图/i;
/** Words of a file title or category that mark a page of print or a map, not a photograph. */
const PRINT_WORDS = new Set([
  "cover",
  "book",
  "catalog",
  "catalogue",
  "journal",
  "magazine",
  "newspaper",
  "document",
  "dictionary",
  "leaflet",
  "pamphlet",
  "manuscript",
  "poster",
  "report",
  "page"
]);

/** A photo slot refuses a file whose title or categories name a print genre (book cover, journal page, ...) or a map. */
export function wrongGenre(kind: string | undefined, titleAndCategories: string): boolean {
  if (!kind || !PHOTO_KIND.test(kind)) return false;
  const words = (titleAndCategories.toLowerCase().match(/[a-z]+/g) ?? []).map(stem);
  return words.some(word => PRINT_WORDS.has(word) || (word === "map" && !MAP_KIND.test(kind)));
}
