/**
 * The program's own picture search (no model call): a Wikimedia Commons file search for the picture slots the finder left without a
 * usable picture. At most {@link COMMONS_REQUESTS_PER_SLOT} requests a slot, each raced against {@link COMMONS_REQUEST_MS}, and no new
 * request after {@link COMMONS_CHAPTER_MS} for the chapter. The answers go through the same rules as the finder's (file page source,
 * the subject rule); the caller probes them and dedupes by address and work as for any candidate. Only photographs and drawings are
 * taken (never a page of a PDF, DjVu or TIFF scan), and only a file whose title, description or categories name what the slot asks for
 * and that names enough of the slot's English terms to keep the slot's line as its caption: a file the book could only caption with
 * its own file name is not taken (Primary decision after the v5 run, reversing the "Picture: <file name>" caption of c771a033).
 * Every query asks for bitmap files only: a plain word search ranks scanned books (PDF, DjVu) first, whose pages the rules refuse.
 * A rate-limit answer (429) is asked again after the wait it names (Retry-After) or else {@link COMMONS_BACKOFF_MS}, the queue held for
 * every chapter meanwhile; the chapter waits at most {@link COMMONS_BACKOFF_TOTAL_MS} in all and never past its deadline, and only
 * then ends its search (`limited`). Worst case: {@link COMMONS_REQUESTS_PER_SLOT} requests a slot plus the retries, and none after
 * {@link COMMONS_CHAPTER_MS}. Chapters run side by side, so every request of every chapter goes through one shared queue: one
 * request in flight, {@link COMMONS_SPACING_MS} between the end of one and the start of the next (a burst is what draws the 429).
 */
import { askWords, wordHits, wrongGenre } from "./file-fit";
import { bySubject, fileSourceOf, isDocumentFile } from "./image-quality";

/** The only address the search asks (the port refuses any other). */
export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const COMMONS_REQUESTS_PER_SLOT = 3;
export const COMMONS_PER_SLOT = 3;
export const COMMONS_REQUEST_MS = 10_000;
export const COMMONS_CHAPTER_MS = 45_000;
export const COMMONS_SPACING_MS = 1_000;
/** The waits after a 429 that names none, one per retry of the same request (2 s, 4 s, 8 s). */
export const COMMONS_BACKOFF_MS: readonly number[] = [2_000, 4_000, 8_000];
/** At most this long a chapter waits on 429 answers in all (its deadline still holds). */
export const COMMONS_BACKOFF_TOTAL_MS = 30_000;
/** At most this long a whole book run waits on 429 answers, all chapters together; after that it asks Commons nothing more. */
export const COMMONS_RUN_BACKOFF_MS = 180_000;
/** What one book run has spent on 429 waits (shared by its chapters); `spent`: the run asks Commons nothing more. */
export interface CommonsRunBudget {
  waited: number;
  spent: boolean;
}
/** Why a Commons file was refused, counted per rule for the log. */
export type CommonsRejection = "type" | "document" | "genre" | "words" | "caption" | "subject" | "repeat";
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
  /** The answer's headers (only Retry-After is read). */
  headers?: Record<string, string>;
}
/** GET of a {@link COMMONS_API} address (production: Obsidian's `requestUrl`, `throw: false`). */
export type CommonsFetch = (url: string) => Promise<CommonsResponse>;

/** A slot as the fallback sees it: the plan's lines and English search terms, and what the finder said about it (its subject, its English search words). */
export interface CommonsSlot {
  index: number;
  /** The plan's kind line (a photo slot refuses book covers, printed pages and maps). */
  kind?: string;
  explains: string;
  /** The planner's English search terms (asked first). */
  terms?: readonly string[];
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

/**
 * The queries for a slot, best first: the planner's English terms, the finder's search words, the subject, then what the slot
 * explains (one line, capped; the book's language, so last).
 */
export function commonsQueries(slot: CommonsSlot): string[] {
  const line = (value: string | undefined): string =>
    (value ?? "")
      .replace(/[\s"|]+/g, " ")
      .trim()
      .slice(0, QUERY_MAX)
      .trim();
  const all = [line(slot.terms?.join(" ")), line(slot.search), line(slot.subject), line(slot.explains)].filter(Boolean);
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
export function parseCommonsAnswer(
  text: string,
  slot: CommonsSlot,
  rejected?: Partial<Record<CommonsRejection, number>>
): CommonsCandidate[] {
  const refuse = (rule: CommonsRejection): void => {
    if (rejected) rejected[rule] = (rejected[rule] ?? 0) + 1;
  };
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
    if ([url, page.title, info.url].some(value => typeof value === "string" && isDocumentFile(value))) {
      refuse("document");
      continue;
    }
    if (
      typeof info.mime !== "string" ||
      !FILE_MIME.test(info.mime) ||
      !/^https:\/\//.test(url) ||
      typeof shown !== "string" ||
      !SHOWN_MIME.test(shown) ||
      typeof info.descriptionurl !== "string"
    ) {
      refuse("type");
      continue;
    }
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
    if (wrongGenre(slot.kind, `${title} ${categories}`)) {
      refuse("genre");
      continue;
    }
    const words = askWords(slot);
    const said = `${title} ${about} ${categories}`;
    if (wordHits(words, said) < Math.min(FIT_HITS, words.length) || !words.length) {
      refuse("words");
      continue;
    }
    // The slot's line is the caption only when the file names most (at least half, rounded up) of the slot's English terms, the
    // planner's if it has them, else the finder's search words as one term; a term counts when the file has all its words. Else the
    // file is not taken: its own name is no caption for a book (the slot stays empty and counts toward the shortfall).
    const terms = (slot.terms?.length ? slot.terms : [slot.search ?? ""])
      .map(term => askWords({ explains: "", search: term }))
      .filter(term => term.length);
    const hit = terms.filter(term => wordHits(term, said) === term.length).length;
    if (!terms.length || hit < Math.ceil(terms.length / 2)) {
      refuse("caption");
      continue;
    }
    const candidate = fileSourceOf<CommonsCandidate>({
      title: title || page.title,
      url,
      source: info.descriptionurl,
      caption: slot.explains.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX),
      description: [about, categories].filter(Boolean).join(" · ").slice(0, DESCRIPTION_MAX),
      ...(author ? { author } : {}),
      ...(license ? { license } : {})
    });
    if (!candidate || !bySubject(candidate, slot.subject)) {
      refuse("subject");
      continue;
    }
    if (out.some(have => have.url === candidate.url)) {
      refuse("repeat");
      continue;
    }
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
 * One request at a time for every chapter: a turn starts when the one before it ended (answer, timeout or Stop) plus `spacing` ms.
 * A turn whose chapter stopped or ran out of time while it waited asks nothing (`run` is not called).
 */
export class CommonsQueue {
  private tail: Promise<void> = Promise.resolve();
  /** `sleep`: how a wait is spent (tests: no real time); it resolves early on abort. */
  constructor(
    private readonly spacing = COMMONS_SPACING_MS,
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = abortableSleep
  ) {}
  /** `run`'s answer, or undefined when `skip()` says no once the turn came. The next turn waits for this one to settle. */
  turn<T>(skip: () => boolean, run: () => Promise<T | undefined>): Promise<T | undefined> {
    let asked = false;
    const answer = this.tail.then(() => {
      if (skip()) return undefined;
      asked = true;
      return run();
    });
    const next = (): Promise<void> => (asked ? this.pause() : Promise.resolve());
    this.tail = answer.then(next, next);
    return answer;
  }
  private pause(): Promise<void> {
    return this.spacing > 0 ? this.sleep(this.spacing) : Promise.resolve();
  }
}
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = window.setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
/** The wait a 429 answer names (Retry-After: seconds or an HTTP date), in ms; undefined when it names none. */
export function retryAfterMs(headers: Record<string, string> | undefined, now: number): number | undefined {
  const raw = Object.entries(headers ?? {})
    .find(([name]) => name.toLowerCase() === "retry-after")?.[1]
    ?.trim();
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
/** The queue the production search uses (shared by every chapter of every run). */
export const commonsQueue = new CommonsQueue();

/**
 * Up to {@link COMMONS_PER_SLOT} candidates per slot, slots in order, one request at a time. A slot's next query is asked only when
 * the ones before gave nothing usable. `skip` refuses addresses the chapter already tried or the book uses. A 429 answer is asked
 * again after its wait (see the file comment); once the waits are spent nothing more is asked (`limited`), and `cut` lists the slots
 * left without a candidate from then on. Every request waits its turn in `queue` (default: the shared {@link commonsQueue}). Never
 * throws (a Stop ends early).
 */
export async function searchCommons(
  slots: readonly CommonsSlot[],
  fetch: CommonsFetch,
  options: {
    signal: AbortSignal;
    skip: (url: string) => boolean;
    now?: () => number;
    queue?: CommonsQueue;
    /** The book run's 429 waits so far (see {@link COMMONS_RUN_BACKOFF_MS}); absent: this search alone. */
    run?: CommonsRunBudget;
  }
): Promise<{
  bySlot: Map<number, CommonsCandidate[]>;
  requests: number;
  limited: boolean;
  cut: number[];
  rejected: Partial<Record<CommonsRejection, number>>;
}> {
  const now = options.now ?? Date.now;
  const deadline = now() + COMMONS_CHAPTER_MS;
  const queue = options.queue ?? commonsQueue;
  const bySlot = new Map<number, CommonsCandidate[]>();
  let requests = 0;
  let limited = false;
  let waited = 0;
  const cut: number[] = [];
  const rejected: Partial<Record<CommonsRejection, number>> = {};
  const run = options.run ?? { waited: 0, spent: false };
  if (run.spent) limited = true;
  const stopped = (): boolean => limited || run.spent || options.signal.aborted || now() >= deadline;
  // One request; on a 429 the turn also holds the queue for the wait (Commons asked every chapter to slow down), or gives up.
  const ask = (query: string, retry: number) =>
    queue.turn(stopped, async () => {
      requests++;
      const answer = await bounded(
        Promise.resolve().then(() => fetch(commonsSearchUrl(query))),
        COMMONS_REQUEST_MS,
        options.signal
      );
      if (answer?.status !== 429) return answer;
      const wait = retryAfterMs(answer.headers, now()) ?? COMMONS_BACKOFF_MS[retry];
      if (wait !== undefined && run.waited + wait > COMMONS_RUN_BACKOFF_MS) run.spent = true;
      if (
        run.spent ||
        retry >= COMMONS_BACKOFF_MS.length ||
        wait === undefined ||
        waited + wait > COMMONS_BACKOFF_TOTAL_MS ||
        now() + wait >= deadline
      ) {
        limited = true;
        return answer;
      }
      waited += wait;
      run.waited += wait;
      await queue.sleep(wait, options.signal);
      return answer;
    });
  for (const slot of slots) {
    const list: CommonsCandidate[] = [];
    for (const query of commonsQueries(slot)) {
      if (list.length || stopped()) break;
      let answer = await ask(query, 0);
      for (let retry = 1; answer?.status === 429 && !stopped(); retry++) answer = await ask(query, retry);
      if (!answer || answer.status !== 200) continue;
      for (const candidate of parseCommonsAnswer(answer.text, slot, rejected)) {
        if (list.length >= COMMONS_PER_SLOT) break;
        if (!options.skip(candidate.url)) list.push(candidate);
      }
    }
    if (list.length) bySlot.set(slot.index, list);
    else if (limited || run.spent) cut.push(slot.index);
  }
  return { bySlot, requests, limited: limited || run.spent, cut, rejected };
}
