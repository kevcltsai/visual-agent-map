/**
 * Planning pieces of share translation (D-2026-10-116): batch sizes, the call and time estimate, segment hashes and the
 * in-memory translation cache. Pure; no DOM, no obsidian import.
 */

/** Characters of body text per call (about six thousand; measured on a 62k-character map: 10 calls). */
export const TRANSLATE_BATCH_CHARS = 6000;
/** Titles, summaries and reasons are short and independent, so more of them go into one call. */
export const TRANSLATE_FIELD_BATCH_CHARS = 12000;
/** Diagram labels per call. */
export const TRANSLATE_LABEL_BATCH_CHARS = 6000;
/** Calls in flight at once. */
export const TRANSLATE_CONCURRENCY = 3;
/** A failed batch is sent once more (the failed items only). */
export const TRANSLATE_RETRIES = 1;
/** Estimated wall time of one call; the estimate shown to the user is calls / concurrency * this. */
export const TRANSLATE_SECONDS_PER_CALL = 40;
/** More than this share of segments left in the original language marks a language incomplete. */
export const TRANSLATE_INCOMPLETE_RATIO = 0.1;
/** Maps whose translations stay in the session cache. */
export const TRANSLATE_CACHE_MAPS = 3;

export interface TranslateItem {
  /** Unique within one batch plan; the model echoes it. */
  id: string;
  text: string;
}

/**
 * Groups items into batches of at most `limit` characters, in order. An item longer than the limit goes alone.
 */
export function planBatches(items: readonly TranslateItem[], limit: number): TranslateItem[][] {
  const batches: TranslateItem[][] = [];
  let current: TranslateItem[] = [];
  let size = 0;
  for (const item of items) {
    if (current.length && size + item.text.length > limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += item.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

/** A fast 53-bit string hash (cyrb53), as base 36. Not a security hash: it only keys the cache. */
export function segmentHash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** Cache key: map, target language, model and the hash of the segment text. */
export function translationCacheKey(language: string, model: string, hash: string): string {
  return `${language}\u0000${model}\u0000${hash}`;
}

/**
 * Translated segments kept in memory for this Obsidian session (never written to disk): keyed by map, language,
 * model and segment hash. Pressing the button again with nothing changed finds everything here and makes 0 calls;
 * a cancelled run keeps what it finished. The most recently used 3 maps stay; a fourth evicts the oldest.
 */
export class ShareTranslationCache {
  private readonly maps = new Map<string, Map<string, string>>();
  constructor(private readonly maxMaps: number = TRANSLATE_CACHE_MAPS) {}

  private touch(mapId: string): Map<string, string> {
    const existing = this.maps.get(mapId);
    if (existing) {
      this.maps.delete(mapId);
      this.maps.set(mapId, existing);
      return existing;
    }
    const created = new Map<string, string>();
    this.maps.set(mapId, created);
    while (this.maps.size > this.maxMaps) {
      const oldest: string | undefined = [...this.maps.keys()][0];
      if (oldest === undefined) break;
      this.maps.delete(oldest);
    }
    return created;
  }

  get(mapId: string, language: string, model: string, hash: string): string | undefined {
    const map = this.maps.get(mapId);
    if (!map) return undefined;
    const value = map.get(translationCacheKey(language, model, hash));
    if (value !== undefined) this.touch(mapId);
    return value;
  }
  set(mapId: string, language: string, model: string, hash: string, value: string): void {
    this.touch(mapId).set(translationCacheKey(language, model, hash), value);
  }
  has(mapId: string, language: string, model: string, hash: string): boolean {
    return this.maps.get(mapId)?.has(translationCacheKey(language, model, hash)) ?? false;
  }
  clearMap(mapId: string): void {
    this.maps.delete(mapId);
  }
  /** Drops everything (the plugin does this when it unloads). */
  clear(): void {
    this.maps.clear();
  }
  get mapCount(): number {
    return this.maps.size;
  }
  get size(): number {
    let total = 0;
    for (const map of this.maps.values()) total += map.size;
    return total;
  }
}

/** What there is to translate, in characters; the estimate before anything is segmented in full. */
export interface TranslateWorkload {
  bodyChars: number;
  fieldChars: number;
  labelChars: number;
}

/** Calls for one language when nothing is cached: one per started batch of each kind. */
export function estimateCallsFromWorkload(work: TranslateWorkload): number {
  const calls = (chars: number, limit: number): number => (chars > 0 ? Math.ceil(chars / limit) : 0);
  return (
    calls(work.bodyChars, TRANSLATE_BATCH_CHARS) +
    calls(work.fieldChars, TRANSLATE_FIELD_BATCH_CHARS) +
    calls(work.labelChars, TRANSLATE_LABEL_BATCH_CHARS)
  );
}

/** Minutes the calls take with the allowed parallelism; at least 1 when there is any call, 0 when there is none. */
export function estimateMinutes(calls: number): number {
  if (calls <= 0) return 0;
  return Math.max(1, Math.round(((calls / TRANSLATE_CONCURRENCY) * TRANSLATE_SECONDS_PER_CALL) / 60));
}

/** True when more than the allowed share of segments stayed in the original language. */
export function isIncomplete(failed: number, total: number): boolean {
  return total > 0 && failed / total > TRANSLATE_INCOMPLETE_RATIO;
}
