/**
 * Argument map source proof. A source counts as evidence only when the program itself opened the URL and found the quoted text
 * (`page_match`), or when the program was blocked and the provider's own tool log shows it opened that exact URL
 * (`provider_read`). Everything else is `not_found`: a 404, a DNS failure, an invented URL, a quote that is not on the page, a
 * URL that appears only in the AI's text. What this cannot prove: that the page supports the claim, and that a `provider_read`
 * page really says what the provider reported. Spec: docs/history/tasks/2026-11-09-argument-map-layout (plan section 3).
 */
import type { SourceFigure, SourceProof } from "./model";

export const QUOTE_MIN = 12;
export const QUOTE_MAX = 200;
/** After folding, a quote shorter than this carries too little text to prove anything (for example punctuation only). */
const QUOTE_FOLDED_MIN = 8;
export const FETCH_TIMEOUT_MS = 15_000;
/** `requestUrl` cannot cap a download, so size is judged afterwards: a larger body is not parsed. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
/** An HTML page with less visible text than this and no quote is treated as a script-rendered shell. */
const SHELL_TEXT_MAX = 200;

export type NotFoundReason =
  | "rejected_url"
  | "bad_quote"
  | "bad_claim"
  | "network_error"
  | "http_status"
  | "content_type"
  | "no_parser"
  | "quote_missing"
  | "blocked_unverified";

export type SourceCheck = { ok: true; proof: SourceProof } | { ok: false; result: "not_found"; reason: NotFoundReason };

/** The slice of Obsidian's `requestUrl` this module uses. */
export interface FetchRequest {
  url: string;
  method: "GET";
  throw: false;
}
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** Where the request ended up, when the transport says (after redirects). */
  url?: string;
  arrayBuffer?: { byteLength: number };
}
export type FetchPage = (request: FetchRequest) => Promise<FetchResponse>;

export interface VerifySourceInput {
  url: string;
  quote: string;
  claim: string;
  /** The figure the AI reported; kept on the proof only when its number is in the quote or the fetched page. */
  figure?: SourceFigure;
  /** URLs the provider's tool log shows it opened successfully during this same call. */
  openedUrls: readonly string[];
  fetch: FetchPage;
  now?: () => string;
  /** Visible text of an HTML string, from an inert document (see {@link inertHtmlText}). Without one, HTML fails closed. */
  parseHtml?: (html: string) => string;
  timeoutMs?: number;
}

const TIMED_OUT = Symbol("timed out");

function ipv4Blocked(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".home.arpa",
  ".corp",
  ".localdomain",
  ".arpa"
];

/** The eight 16-bit groups of a normalized IPv6 literal (as `URL` prints it, so no dotted tail), or null when malformed. */
function ipv6Groups(literal: string): number[] | null {
  const parts = literal.split("::");
  if (parts.length > 2) return null;
  const read = (text: string): number[] | null => {
    if (!text) return [];
    const groups = text.split(":").map(g => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return groups.some(Number.isNaN) ? null : groups;
  };
  const head = read(parts[0] ?? "");
  const tail = parts.length === 2 ? read(parts[1] ?? "") : [];
  if (!head || !tail) return null;
  if (parts.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<number>(fill).fill(0), ...tail];
}

const embeddedBlocked = (high: number): boolean => ipv4Blocked(high >> 8, high & 0xff);

function ipv6Blocked(literal: string): boolean {
  const g = ipv6Groups(literal);
  if (!g) return true;
  const first = g[0];
  const rest = g.slice(1);
  if (first >= 0xff00) return true; // multicast ff00::/8
  if ((first & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true; // link-local and site-local
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return true; // IPv4-mapped
  if (g.slice(0, 6).every(x => x === 0)) return embeddedBlocked(g[6]); // IPv4-compatible, ::, ::1
  if (first === 0x64 && g[1] === 0xff9b && rest.slice(1, 5).every(x => x === 0)) return embeddedBlocked(g[6]); // NAT64
  if (first === 0x2002) return embeddedBlocked(g[1]); // 6to4
  return false;
}

/**
 * The parsed URL when it may be fetched: http(s), no credentials, no single-label or local-suffix name, no private, loopback,
 * link-local, multicast or embedded-private address literal. DNS names that resolve to a private address cannot be seen here.
 */
export function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host === "localhost" || host === "home.arpa" || host === "arpa" || host === "localdomain") return null;
  if (PRIVATE_SUFFIXES.some(suffix => host.endsWith(suffix))) return null;
  if (host.startsWith("[")) return ipv6Blocked(host.slice(1, -1)) ? null : url;
  if (!host.includes(".")) return null;
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (octets && ipv4Blocked(Number(octets[1]), Number(octets[2]))) return null;
  return url;
}

/** Same page for matching purposes: host case, fragment and a trailing slash do not matter. */
function canonical(url: URL): string {
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** NFKC, lower case, and every whitespace, punctuation, symbol and control character removed. */
export function foldText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}\p{Cc}\p{Cf}]/gu, "");
}

/** The numbers a text carries (NFKC, thousands commas dropped): "1,200" and "1200" are one number. */
export function numbersIn(text: string): string[] {
  return (text.normalize("NFKC").match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => n.replace(/,/g, "").replace(/\.0+$/, ""));
}

function header(headers: Record<string, string>, name: string): string {
  for (const key of Object.keys(headers ?? {})) if (key.toLowerCase() === name) return String(headers[key]);
  return "";
}

/** Visible text of an HTML string through DOMParser, which builds an inert document: nothing in it runs or loads. */
export function inertHtmlText(html: string): string {
  const parser = (window as unknown as { DOMParser?: new () => { parseFromString(s: string, t: string): Document } })
    .DOMParser;
  if (!parser) return "";
  const doc = new parser().parseFromString(html, "text/html");
  for (const el of Array.from(doc.querySelectorAll("script,style,noscript,template"))) el.remove();
  return doc.documentElement.textContent ?? "";
}

/** URLs the provider opened successfully, from its web events (Claude WebFetch and Codex openPage carry `action.url`). */
export function openedUrlsFromEvents(events: readonly unknown[]): string[] {
  const urls: string[] = [];
  for (const event of events) {
    const e = event as {
      method?: unknown;
      params?: { item?: { type?: unknown; action?: { type?: unknown; url?: unknown } } };
    } | null;
    if (!e || typeof e !== "object" || e.method !== "item/completed") continue;
    const item = e.params?.item;
    if (item?.type !== "webSearch" || item.action?.type !== "openPage") continue;
    if (typeof item.action.url === "string" && item.action.url) urls.push(item.action.url);
  }
  return urls;
}

/** Search queries the provider ran, from its completed search events (`action.query` or `action.queries`); blank and repeated ones dropped. */
export function searchQueriesFromEvents(events: readonly unknown[]): string[] {
  const queries: string[] = [];
  const add = (value: unknown): void => {
    if (typeof value !== "string") return;
    const query = value.trim();
    if (query && !queries.includes(query)) queries.push(query);
  };
  for (const event of events) {
    const e = event as {
      method?: unknown;
      params?: { item?: { type?: unknown; action?: { type?: unknown; query?: unknown; queries?: unknown } | null } };
    } | null;
    if (!e || typeof e !== "object" || e.method !== "item/completed") continue;
    const item = e.params?.item;
    if (item?.type !== "webSearch" || item.action?.type !== "search") continue;
    add(item.action.query);
    if (Array.isArray(item.action.queries)) for (const query of item.action.queries as unknown[]) add(query);
  }
  return queries;
}

async function fetchWithTimeout(
  fetch: FetchPage,
  url: string,
  timeoutMs: number
): Promise<FetchResponse | typeof TIMED_OUT> {
  let timer: number | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = window.setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  const request = Promise.resolve().then(() => fetch({ url, method: "GET", throw: false }));
  // The request cannot be aborted; a late failure after the race is settled must not surface as an unhandled rejection.
  request.catch(() => undefined);
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

export async function verifySource(input: VerifySourceInput): Promise<SourceCheck> {
  const fail = (reason: NotFoundReason): SourceCheck => ({ ok: false, result: "not_found", reason });
  const url = allowedUrl(input.url);
  if (!url) return fail("rejected_url");
  const quote = input.quote.normalize("NFKC").trim();
  const length = Array.from(quote).length;
  const foldedQuote = foldText(quote);
  if (length < QUOTE_MIN || length > QUOTE_MAX || Array.from(foldedQuote).length < QUOTE_FOLDED_MIN)
    return fail("bad_quote");
  if (!input.claim.trim()) return fail("bad_claim");

  const requested = new URL(url.href);
  requested.hash = "";
  // The quote vouches only for the numbers it carries (or the page the program read). A claim or figure with a number
  // outside them is not proved: the claim becomes the quote itself and the figure is dropped.
  const proof = (check: SourceProof["check"], pageText?: string): SourceCheck => {
    const seen = new Set([...numbersIn(input.quote), ...(pageText ? numbersIn(pageText) : [])]);
    const claim = input.claim.trim();
    const claimOk = numbersIn(claim).every(n => seen.has(n));
    const figureNumbers = input.figure ? numbersIn(input.figure.number) : [];
    const figureOk = figureNumbers.length > 0 && figureNumbers.every(n => seen.has(n));
    return {
      ok: true,
      proof: {
        url: requested.href,
        quote: input.quote.trim(),
        claim: claimOk ? claim : input.quote.trim(),
        ...(claimOk ? {} : { claimUnverified: true }),
        check,
        checkedAt: (input.now ?? (() => new Date().toISOString()))(),
        ...(figureOk ? { figure: input.figure } : {})
      }
    };
  };
  const key = canonical(requested);
  const openedByProvider = input.openedUrls.some(opened => {
    const parsed = allowedUrl(opened);
    return !!parsed && canonical(parsed) === key;
  });
  /** The program could not read the page itself: only the provider's own tool log can vouch for it. */
  const blocked = (): SourceCheck => (openedByProvider ? proof("provider_read") : fail("blocked_unverified"));

  let response: FetchResponse | typeof TIMED_OUT;
  try {
    response = await fetchWithTimeout(input.fetch, requested.href, input.timeoutMs ?? FETCH_TIMEOUT_MS);
  } catch {
    return fail("network_error");
  }
  if (response === TIMED_OUT) return blocked();

  // A redirect that left the requested host, or landed anywhere not allowed, is not the page that was asked for: fail closed.
  if (typeof response.url === "string" && response.url) {
    const final = allowedUrl(response.url);
    if (
      !final ||
      final.protocol !== requested.protocol ||
      final.host.toLowerCase().replace(/\.$/, "") !== requested.host.toLowerCase().replace(/\.$/, "")
    )
      return fail("rejected_url");
  }
  const { status } = response;
  if (status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599)) return blocked();
  if (status < 200 || status > 299) return fail("http_status");

  // Declared size first: an oversize body is never read or parsed.
  const declared = Number(header(response.headers, "content-length"));
  if (Number.isFinite(declared) && declared > MAX_PAGE_BYTES) return blocked();
  const type = header(response.headers, "content-type").toLowerCase();
  if (type.includes("application/pdf")) return blocked();
  const size = response.arrayBuffer?.byteLength ?? response.text.length;
  if (size > MAX_PAGE_BYTES) return blocked();
  const isHtml = type === "" || type.includes("text/html") || type.includes("application/xhtml");
  const isPlain = type.includes("text/plain");
  if (!isHtml && !isPlain) return fail("content_type");

  let pageText: string;
  if (isPlain) pageText = response.text;
  else {
    if (!input.parseHtml) return fail("no_parser");
    pageText = input.parseHtml(response.text);
  }
  if (foldText(pageText).includes(foldedQuote)) return proof("page_match", pageText);
  // A page that is readable and lacks the quote is not rescued by the tool log; only an empty shell is.
  if (isHtml && pageText.trim().length < SHELL_TEXT_MAX) return blocked();
  return fail("quote_missing");
}
