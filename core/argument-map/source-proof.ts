/**
 * Argument map source proof. A source counts as evidence only when the program itself opened the URL and found the quoted text
 * (`page_match`), or when the program was blocked and the provider's own tool log shows it opened that exact URL
 * (`provider_read`). Everything else is `not_found`: a 404, a DNS failure, an invented URL, a quote that is not on the page, a
 * URL that appears only in the AI's text. What this cannot prove: that the page supports the claim, and that a `provider_read`
 * page really says what the provider reported. Spec: docs/history/tasks/2026-11-09-argument-map-layout (plan section 3).
 */
import type { SourceProof } from "./model";

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
  arrayBuffer?: { byteLength: number };
}
export type FetchPage = (request: FetchRequest) => Promise<FetchResponse>;

export interface VerifySourceInput {
  url: string;
  quote: string;
  claim: string;
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

/** The parsed URL when it may be fetched: http(s), no credentials, no local name, no private/loopback/link-local literal. */
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
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (host.startsWith("[")) {
    const first = host.slice(1, -1).split(":")[0] ?? "";
    const hextet = first ? parseInt(first, 16) : 0;
    if (host === "[::]" || host === "[::1]" || host.startsWith("[::ffff:")) return null;
    if (hextet >= 0xfc00 && hextet <= 0xfdff) return null;
    if (hextet >= 0xfe80 && hextet <= 0xfebf) return null;
    return url;
  }
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
  const proof = (check: SourceProof["check"]): SourceCheck => ({
    ok: true,
    proof: {
      url: requested.href,
      quote: input.quote.trim(),
      claim: input.claim.trim(),
      check,
      checkedAt: (input.now ?? (() => new Date().toISOString()))()
    }
  });
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

  const { status } = response;
  if (status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599)) return blocked();
  if (status < 200 || status > 299) return fail("http_status");

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
  if (foldText(pageText).includes(foldedQuote)) return proof("page_match");
  // A page that is readable and lacks the quote is not rescued by the tool log; only an empty shell is.
  if (isHtml && pageText.trim().length < SHELL_TEXT_MAX) return blocked();
  return fail("quote_missing");
}
