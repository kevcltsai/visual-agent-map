/**
 * The program's own picture search (no model call): a Wikimedia Commons file search for the picture slots the finder left without a
 * usable picture. At most {@link COMMONS_REQUESTS_PER_SLOT} requests a slot, each raced against {@link COMMONS_REQUEST_MS}, and no new
 * request after {@link COMMONS_CHAPTER_MS} for the chapter. The answers go through the same rules as the finder's (file page source,
 * the subject rule); the caller probes them and dedupes by address and work as for any candidate. Only photographs and drawings are
 * taken (never a page of a PDF, DjVu or TIFF scan), and only a file whose title, description or categories name what the slot asks for.
 * Every query asks for bitmap files only: a plain word search ranks scanned books (PDF, DjVu) first, whose pages the rules refuse.
 * A rate-limit answer (429) ends the search of the chapter. Worst case: {@link COMMONS_REQUESTS_PER_SLOT} requests a slot, and none
 * after {@link COMMONS_CHAPTER_MS}.
 */
import { askWords, wordHits, wrongGenre } from "./file-fit";
import { bySubject, fileSourceOf, isDocumentFile } from "./image-quality";

/** The only address the search asks (the port refuses any other). */
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_REQUESTS_PER_SLOT = 3;
export const COMMONS_PER_SLOT = 3;
export const COMMONS_REQUEST_MS = 10_000;
export const COMMONS_CHAPTER_MS = 45_000;
const QUERY_MAX = 80;
const CREDIT_MAX = 100;
const CAPTION_MAX = 200;
const DESCRIPTION_MAX = 300;
/** The file types a book may take from Commons: photographs and drawings (an SVG only through its PNG thumbnail). */
const FILE_MIME = /^image\/(?:jpeg|png|webp|svg\+xml)$/i;
/** What the book shows: the thumbnail's type. */
const SHOWN_MIME = /^image\/(?:jpeg|png|webp)$/i;
/** A file must name at least this many of the slot's words (all of them when the slot has fewer). */
const FIT_HITS = 2;

export interface CommonsResponse {
  status: number;
  text: string;
}
/** GET of a {@link COMMONS_API} address (production: Obsidian's `requestUrl`, `throw: false`). */
export type CommonsFetch = (url: string) => Promise<CommonsResponse>;

/** A slot as the fallback sees it, with what the finder said about it (its subject, its English search words). */
export interface CommonsSlot {
  index: number;
  /** The plan's kind line (a photo slot refuses book covers, printed pages and maps). */
  kind?: string;
  explains: string;
  subject?: string;
  search?: string;
}
export interface CommonsCandidate {
  title: string;
  url: string;
  source: string;
  caption: string;
  /** What the file page says about the file: its description and categories (plain text, capped). */
  description: string;
  /** The file does not name every English search word of its slot: the caption is the file's own name, not the slot's line. */
  loose?: true;
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
    gsrsearch: `${query} filetype:bitmap`,
    gsrlimit: "20",
    prop: "imageinfo",
    iiprop: "url|mime|thumbmime|extmetadata",
    iiurlwidth: "1280",
    iiextmetadatafilter: "Artist|LicenseShortName|ImageDescription|Categories"
  };
  const pairs = Object.entries(params).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `${COMMONS_API}?${pairs.join("&")}`;
}

/** The queries for a slot, best first: the finder's search words, the subject, then what the slot explains (one line, capped). */
export function commonsQueries(slot: CommonsSlot): string[] {
  const line = (value: string | undefined): string =>
    (value ?? "")
      .replace(/[\s"|]+/g, " ")
      .trim()
      .slice(0, QUERY_MAX)
      .trim();
  const all = [line(slot.search), line(slot.subject), line(slot.explains)].filter(Boolean);
  return [...new Set(all)].slice(0, COMMONS_REQUESTS_PER_SLOT);
}

/** File page HTML (`<a …>Name</a>`) as one plain line, capped. */
function plainCredit(value: unknown, max = CREDIT_MAX): string {
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
    .slice(0, max);
}

/**
 * One search answer as candidates in search order: a photograph or drawing (no document page), an https thumbnail, the file page as
 * source, the subject rule, a file that names what the slot asks for, and for a photo slot no print genre or map.
 */
export function parseCommonsAnswer(text: string, slot: CommonsSlot): CommonsCandidate[] {
  let parsed: { query?: { pages?: unknown } };
  try {
    parsed = JSON.parse(text) as { query?: { pages?: unknown } };
  } catch {
    return [];
  }
  const pages = Array.isArray(parsed?.query?.pages)
    ? (parsed.query.pages as Array<Record<string, unknown> | null>)
    : [];
  const ranked = pages
    .filter((page): page is Record<string, unknown> => !!page && typeof page === "object")
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const out: CommonsCandidate[] = [];
  for (const page of ranked) {
    const info = Array.isArray(page.imageinfo) ? (page.imageinfo[0] as Record<string, unknown> | undefined) : undefined;
    if (!info || typeof page.title !== "string") continue;
    const url = typeof info.thumburl === "string" ? info.thumburl : typeof info.url === "string" ? info.url : "";
    const shown = typeof info.thumbmime === "string" ? info.thumbmime : info.mime;
    if (typeof info.mime !== "string" || !FILE_MIME.test(info.mime)) continue;
    if (!/^https:\/\//.test(url) || typeof shown !== "string" || !SHOWN_MIME.test(shown)) continue;
    if (typeof info.descriptionurl !== "string") continue;
    if ([url, page.title, info.url].some(value => typeof value === "string" && isDocumentFile(value))) continue;
    const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown } | undefined>;
    const author = plainCredit(meta.Artist?.value);
    const license = plainCredit(meta.LicenseShortName?.value);
    const categories = plainCredit(meta.Categories?.value, DESCRIPTION_MAX).replace(/\|/g, "; ");
    const about = plainCredit(meta.ImageDescription?.value, DESCRIPTION_MAX);
    const title = page.title
      .replace(/^File:/i, "")
      .replace(/\.[a-z0-9]{2,5}$/i, "")
      .replace(/_/g, " ")
      .trim();
    if (wrongGenre(slot.kind, `${title} ${categories}`)) continue;
    const words = askWords(slot);
    const said = `${title} ${about} ${categories}`;
    if (wordHits(words, said) < Math.min(FIT_HITS, words.length) || !words.length) continue;
    // The slot's line is the caption only when the file names every English search word of the slot; else the file's own name is.
    const terms = askWords({ explains: "", search: slot.search });
    const fits = terms.length > 0 && wordHits(terms, said) === terms.length;
    const candidate = fileSourceOf<CommonsCandidate>({
      title: title || page.title,
      url,
      source: info.descriptionurl,
      caption: (fits ? slot.explains : title || page.title).replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX),
      description: [about, categories].filter(Boolean).join(" · ").slice(0, DESCRIPTION_MAX),
      ...(author ? { author } : {}),
      ...(license ? { license } : {}),
      ...(fits ? {} : { loose: true as const })
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
 * Up to {@link COMMONS_PER_SLOT} candidates per slot, slots in order, one request at a time. A slot's next query is asked only when
 * the ones before gave nothing usable. `skip` refuses addresses the chapter already tried or the book uses. A 429 answer asks nothing
 * more (`limited`). Never throws (a Stop ends early).
 */
export async function searchCommons(
  slots: readonly CommonsSlot[],
  fetch: CommonsFetch,
  options: { signal: AbortSignal; skip: (url: string) => boolean; now?: () => number }
): Promise<{ bySlot: Map<number, CommonsCandidate[]>; requests: number; limited: boolean }> {
  const now = options.now ?? Date.now;
  const deadline = now() + COMMONS_CHAPTER_MS;
  const bySlot = new Map<number, CommonsCandidate[]>();
  let requests = 0;
  let limited = false;
  for (const slot of slots) {
    const list: CommonsCandidate[] = [];
    for (const query of commonsQueries(slot)) {
      if (list.length || limited || options.signal.aborted || now() >= deadline) break;
      requests++;
      const answer = await bounded(
        Promise.resolve().then(() => fetch(commonsSearchUrl(query))),
        COMMONS_REQUEST_MS,
        options.signal
      );
      if (answer?.status === 429) limited = true;
      if (!answer || answer.status !== 200) continue;
      for (const candidate of parseCommonsAnswer(answer.text, slot)) {
        if (list.length >= COMMONS_PER_SLOT) break;
        if (!options.skip(candidate.url)) list.push(candidate);
      }
    }
    if (list.length) bySlot.set(slot.index, list);
  }
  return { bySlot, requests, limited };
}
