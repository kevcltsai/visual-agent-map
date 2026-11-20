/**
 * The program's own picture search (no model call): a Wikimedia Commons file search for the picture slots the finder left without a
 * usable picture. At most {@link COMMONS_REQUESTS_PER_SLOT} requests a slot, each raced against {@link COMMONS_REQUEST_MS}, and no new
 * request after {@link COMMONS_CHAPTER_MS} for the chapter. The answers go through the same rules as the finder's (file page source,
 * the subject rule); the caller probes them and dedupes by address and work as for any candidate.
 */
import { bySubject, fileSourceOf } from "./image-quality";

/** The only address the search asks (the port refuses any other). */
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_REQUESTS_PER_SLOT = 2;
export const COMMONS_PER_SLOT = 3;
export const COMMONS_REQUEST_MS = 10_000;
export const COMMONS_CHAPTER_MS = 45_000;
const QUERY_MAX = 80;
const CREDIT_MAX = 100;
const CAPTION_MAX = 200;
/** What a book may show: the raster types the finder is held to (an SVG drawing only through its PNG thumbnail). */
const SAFE_MIME = /^image\/(?:jpeg|png|gif|webp)$/i;

export interface CommonsResponse {
  status: number;
  text: string;
}
/** GET of a {@link COMMONS_API} address (production: Obsidian's `requestUrl`, `throw: false`). */
export type CommonsFetch = (url: string) => Promise<CommonsResponse>;

/** A slot as the fallback sees it, with what the finder said about it (its subject, its English search words). */
export interface CommonsSlot {
  index: number;
  explains: string;
  subject?: string;
  search?: string;
}
export interface CommonsCandidate {
  title: string;
  url: string;
  source: string;
  caption: string;
  author?: string;
  license?: string;
}

/** The search address: files only, image info with the 1280px thumbnail and the credit fields of the file page. */
export function commonsSearchUrl(query: string): string {
  const params: Record<string, string> = {
    action: "query",
    format: "json",
    formatversion: "2",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    gsrlimit: "10",
    prop: "imageinfo",
    iiprop: "url|mime|thumbmime|extmetadata",
    iiurlwidth: "1280",
    iiextmetadatafilter: "Artist|LicenseShortName"
  };
  const pairs = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `${COMMONS_API}?${pairs.join("&")}`;
}

/** The queries for a slot, best first: the finder's search words, the subject, then what the slot explains (one line, capped). */
export function commonsQueries(slot: CommonsSlot): string[] {
  const line = (value: string | undefined): string =>
    (value ?? "").replace(/[\s"|]+/g, " ").trim().slice(0, QUERY_MAX).trim();
  const all = [line(slot.search), line(slot.subject), line(slot.explains)].filter(Boolean);
  return [...new Set(all)].slice(0, COMMONS_REQUESTS_PER_SLOT);
}

/** File page HTML credit (`<a …>Name</a>`) as one plain line. */
function plainCredit(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CREDIT_MAX);
}

/** One search answer as candidates in search order: safe image types, an https thumbnail, the file page as source, the subject rule. */
export function parseCommonsAnswer(text: string, slot: CommonsSlot): CommonsCandidate[] {
  let parsed: { query?: { pages?: unknown } };
  try {
    parsed = JSON.parse(text) as { query?: { pages?: unknown } };
  } catch {
    return [];
  }
  const pages = Array.isArray(parsed?.query?.pages) ? (parsed.query.pages as Array<Record<string, unknown> | null>) : [];
  const ranked = pages
    .filter((page): page is Record<string, unknown> => !!page && typeof page === "object")
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const out: CommonsCandidate[] = [];
  for (const page of ranked) {
    const info = Array.isArray(page.imageinfo) ? (page.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    if (!info || typeof page.title !== "string") continue;
    const url = typeof info.thumburl === "string" ? info.thumburl : typeof info.url === "string" ? info.url : "";
    const mime = typeof info.thumbmime === "string" ? info.thumbmime : info.mime;
    if (!/^https:\/\//.test(url) || typeof mime !== "string" || !SAFE_MIME.test(mime)) continue;
    if (typeof info.descriptionurl !== "string") continue;
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown } | undefined>;
    const author = plainCredit(meta.Artist?.value);
    const license = plainCredit(meta.LicenseShortName?.value);
    const title = page.title.replace(/^File:/i, "").replace(/\.[a-z0-9]{2,5}$/i, "").replace(/_/g, " ").trim();
    const candidate = fileSourceOf<CommonsCandidate>({
      title: title || page.title,
      url,
      source: info.descriptionurl,
      // The program writes no caption of its own: the slot's line (in the book's language) says what the picture is for.
      caption: slot.explains.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX),
      ...(author ? { author } : {}),
      ...(license ? { license } : {})
    });
    if (!candidate || !bySubject(candidate, slot.subject)) continue;
    if (out.some(have => have.url === candidate.url)) continue;
    out.push(candidate);
  }
  return out;
}

/** Resolves undefined after `ms` or on abort, else the work's answer (a failed request is undefined). */
function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
  return new Promise(resolve => {
    const done = (value: T | undefined): void => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => done(undefined);
    const timer = window.setTimeout(() => done(undefined), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(done, () => done(undefined));
  });
}

/**
 * Up to {@link COMMONS_PER_SLOT} candidates per slot, slots in order, one request at a time. A slot's second query is asked only when
 * the first gave nothing usable. `skip` refuses addresses the chapter already tried or the book uses. Never throws (a Stop ends early).
 */
export async function searchCommons(
  slots: readonly CommonsSlot[],
  fetch: CommonsFetch,
  options: { signal: AbortSignal; skip: (url: string) => boolean; now?: () => number }
): Promise<{ bySlot: Map<number, CommonsCandidate[]>; requests: number }> {
  const now = options.now ?? Date.now;
  const deadline = now() + COMMONS_CHAPTER_MS;
  const bySlot = new Map<number, CommonsCandidate[]>();
  let requests = 0;
  for (const slot of slots) {
    const list: CommonsCandidate[] = [];
    for (const query of commonsQueries(slot)) {
      if (list.length || options.signal.aborted || now() >= deadline) break;
      requests++;
      const answer = await bounded(Promise.resolve().then(() => fetch(commonsSearchUrl(query))), COMMONS_REQUEST_MS, options.signal);
      if (!answer || answer.status !== 200) continue;
      for (const candidate of parseCommonsAnswer(answer.text, slot)) {
        if (list.length >= COMMONS_PER_SLOT) break;
        if (!options.skip(candidate.url)) list.push(candidate);
      }
    }
    if (list.length) bySlot.set(slot.index, list);
  }
  return { bySlot, requests };
}
