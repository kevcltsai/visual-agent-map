/**
 * The proofread verdict, decided by program, not by the model. The model returns one result per checklist item; this
 * module checks the list against the checklist, accepts a source only when this very call opened it (an openPage event),
 * downgrades an unsupported "met" on a fact item to "unverified", and applies the whole-card failure rules. It also keeps
 * the stored record (appended to the research notes under a dedupe key, reused when a run resumes). Pure: it never sees
 * or changes the card's body.
 */
import type { ChecklistItem } from "./plan-text";
import { escapeMarkdownText, hashText, singleLine } from "./text";

export const PROOF_STATUSES = ["met", "unmet", "unverified"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export interface RawProofItem {
  id: string;
  status: ProofStatus;
  note: string;
  sources: string[];
}
export interface ProofItemResult {
  id: string;
  type: ChecklistItem["type"];
  status: ProofStatus;
  note: string;
  /** Only URLs this call opened, as the event reported them. */
  sources: string[];
}
export interface ProofResult {
  items: ProofItemResult[];
  /** `needs-review` when a fact item is unmet (a source contradicts the list); otherwise `checked`. Unmet structure items and unverified items are recorded, not blocking. */
  aggregate: "checked" | "needs-review";
  /**
   * True when pages were opened but every fact item stayed "unverified": retrying cannot help, so the judged items are kept,
   * the card is `needs-review` and its note says "facts unverified" (a call that opened no page is still a failure, `no_open_page`).
   */
  factsUnverified?: boolean;
  /** What the call did, as numbers only (no query or address): successful page opens and completed searches. */
  counts?: ProofCounts;
}
export interface ProofCounts {
  openedPages: number;
  searches: number;
}

export type ProofFailureCode =
  | "unparsable"
  | "empty_list"
  | "missing_item"
  | "duplicate_item"
  | "unknown_item"
  | "no_open_page"
  /** No longer thrown (a result with `factsUnverified` is returned instead); kept so old log lines and the reason map stay readable. */
  | "all_facts_unverified";
/** A whole-card failure (retry, three times, then needs-review). The message is the code only. */
export class ProofFailure extends Error {
  /**
   * The judgments already made when the failure is "no page opened" or "all facts unverified": the structure items are real
   * results, so the caller keeps them in the research notes (the card still needs a human).
   */
  constructor(
    readonly code: ProofFailureCode,
    readonly partial?: ProofResult,
    readonly counts?: ProofCounts
  ) {
    super(code);
    this.name = "ProofFailure";
  }
}

/** By name, so it holds across module copies. */
export const isProofFailure = (error: unknown): error is ProofFailure =>
  !!error && typeof error === "object" && (error as { name?: unknown }).name === "ProofFailure";

const TRACKING = /^(?:utm_[a-z0-9_]*|fbclid|gclid)$/i;
/**
 * The key two spellings of one page share, never a way to reach a page nobody opened: the host in lower case, no fragment, no
 * default port, no trailing slash, no tracking parameters (utm_*, fbclid, gclid); http and https share one key (a model's http
 * spelling matches an https event; an http event is never a source, see {@link safeHref}, and the saved address is always the
 * event's own). Any other difference (path, other parameters, another host, credentials) is another page.
 */
const normalizeUrl = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || /[\s\p{Cc}]/u.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname)
    return undefined;
  const kept = url.search
    .slice(1)
    .split("&")
    .filter(pair => pair && !TRACKING.test(pair.split("=")[0]));
  const query = kept.length ? `?${kept.join("&")}` : "";
  return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}${query}`;
};

/**
 * The one URL form a note may carry: https only, parsed by `new URL`, no credentials, no whitespace/control/`<>"`/backtick/
 * backslash in the text given, rebuilt from the URL object, with `()[]'` and a stray `%` percent-encoded so no Markdown
 * link or image can close or open around it. Undefined when it is not such a URL.
 */
export function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 2000 || /[\s\p{Cc}<>"`\\]/u.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
  return url.href
    .replace(/%(?![0-9a-fA-F]{2})/g, "%25")
    .replace(/[()[\]']/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const LEAK_RUN = 40;
/** True when `text` holds a run of {@link LEAK_RUN} or more characters that is also in the chapter `body`. */
export function sharesLongRun(text: string, body: string): boolean {
  const hay = squash(body);
  const chars = Array.from(squash(text));
  if (chars.length < LEAK_RUN || hay.length < LEAK_RUN) return false;
  for (let i = 0; i + LEAK_RUN <= chars.length; i++)
    if (hay.includes(chars.slice(i, i + LEAK_RUN).join(""))) return true;
  return false;
}
const decoded = (text: string): string[] => {
  const forms = [text];
  try {
    const once = decodeURIComponent(text);
    forms.push(once, once.replace(/[+_-]+/g, " "));
  } catch {
    // an undecodable form is checked as it is
  }
  return forms;
};

export const LEAK_NOTE = "來源疑似外洩正文";

export interface ProofGuard {
  /** The chapter text. With it, an opened URL that quotes it (a run of 40 or more characters) is a violation. Search queries are not checked. */
  body: string;
}

export function evaluateProof(
  raw: readonly RawProofItem[],
  checklist: readonly ChecklistItem[],
  openedUrls: readonly string[],
  guard?: ProofGuard
): ProofResult {
  if (!checklist.length) throw new ProofFailure("empty_list");
  const known = new Map(checklist.map(item => [item.id, item]));
  const seen = new Set<string>();
  for (const item of raw) {
    if (!known.has(item.id)) throw new ProofFailure("unknown_item");
    if (seen.has(item.id)) throw new ProofFailure("duplicate_item");
    seen.add(item.id);
  }
  if (checklist.some(item => !seen.has(item.id))) throw new ProofFailure("missing_item");
  const leaks = (text: string): boolean => !!guard && decoded(text).some(form => sharesLongRun(form, guard.body));
  const opened = new Map<string, string>();
  const leakedKeys = new Set<string>();
  for (const url of openedUrls) {
    const key = normalizeUrl(url);
    const href = safeHref(url);
    if (!key || !href) continue;
    if (leaks(url)) leakedKeys.add(key);
    else if (!opened.has(key)) opened.set(key, href);
  }
  // A leaked page is no source; only items citing it drop to unverified.
  const noPage = !opened.size && !leakedKeys.size;
  const items: ProofItemResult[] = checklist.map(entry => {
    const item = raw.find(candidate => candidate.id === entry.id) as RawProofItem;
    const sources: string[] = [];
    let leaked = false;
    for (const source of item.sources) {
      const key = normalizeUrl(source);
      if (key && leakedKeys.has(key)) leaked = true;
      const real = key ? opened.get(key) : undefined;
      if (real && !sources.includes(real)) sources.push(real);
    }
    const note = singleLine(item.note, 300);
    if (leaked) return { id: entry.id, type: entry.type, status: "unverified", note: LEAK_NOTE, sources: [] };
    const status: ProofStatus =
      item.status === "met" && entry.type === "fact" && !sources.length ? "unverified" : item.status;
    return { id: entry.id, type: entry.type, status, note, sources };
  });
  const facts = items.filter(item => item.type === "fact");
  const result: ProofResult = {
    items,
    aggregate: items.some(item => item.type === "fact" && item.status === "unmet") ? "needs-review" : "checked"
  };
  // The partial result of a whole-card failure never reads as checked: the card needs a human.
  const partial: ProofResult = { items, aggregate: "needs-review" };
  if (noPage) throw new ProofFailure("no_open_page", partial);
  if (facts.length && facts.every(item => item.status === "unverified"))
    return { items, aggregate: "needs-review", factsUnverified: true };
  return result;
}

export interface ProofKeyParts {
  runId: string;
  nodeId: string;
  revision: number;
  body: string;
  checklist: readonly ChecklistItem[];
}
/** The key a failed proof's partial record is stored under: never the key of a finished proof, so a retry is not skipped. */
export const failedProofKey = (key: string): string => `${key}:failed`;

/** `runId:card:revision:body hash:checklist hash`. */
export function proofKey(parts: ProofKeyParts): string {
  const list = hashText(JSON.stringify(parts.checklist.map(item => [item.id, item.type, item.text])));
  return `${parts.runId}:${parts.nodeId}:${parts.revision}:${hashText(parts.body)}:${list}`;
}

const safeCount = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
const RECORD = /^<!-- book-proof:v1 (\{.*\}) -->$/;
const escapeJson = (text: string): string => text.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
const STATUS_WORDS: Record<ProofStatus, string> = { met: "達成", unmet: "未達成", unverified: "待查" };

/**
 * The lines appended to the research notes for one proof: readable plain lines and one machine record. The only place the
 * note and sources are made safe (escaped text; https addresses as inline code, so nothing is clickable or loadable).
 */
export function composeProofRecord(key: string, result: ProofResult, failure?: ProofFailureCode): string {
  // Re-checked here too: whatever the result holds, the note only ever gets escaped text and inline-code https addresses.
  const clean: ProofResult = {
    aggregate: result.aggregate,
    ...(result.factsUnverified ? { factsUnverified: true } : {}),
    items: result.items.map(item => ({
      id: escapeMarkdownText(item.id, 20),
      type: item.type,
      status: item.status,
      note: escapeMarkdownText(item.note, 300),
      sources: item.sources.map(safeHref).filter((href): href is string => !!href)
    })),
    ...(result.counts
      ? { counts: { openedPages: safeCount(result.counts.openedPages), searches: safeCount(result.counts.searches) } }
      : {})
  };
  const lines = [
    (failure
      ? `校對失敗（原因：${failure}；以下是已判斷的結果，仍需人看）`
      : `校對（${clean.aggregate === "checked" ? "已校" : clean.factsUnverified ? "需人看；事實項目皆待查" : "需人看"}）`) +
      (clean.counts ? ` 開頁 ${clean.counts.openedPages} 次、搜尋 ${clean.counts.searches} 次` : "")
  ];
  for (const item of clean.items)
    lines.push(
      `- ${item.id} ${STATUS_WORDS[item.status]}：${item.note}${item.sources.length ? `（開頁：${item.sources.map(href => `\`${href}\``).join(" ")}）` : ""}`
    );
  lines.push(
    `<!-- book-proof:v1 ${escapeJson(JSON.stringify({ key, result: clean, ...(failure ? { failed: failure } : {}) }))} -->`
  );
  return lines.join("\n");
}

/** The stored result for `key` in a notes text, or undefined. */
export function findProofRecord(notes: string, key: string): ProofResult | undefined {
  for (const line of notes.split(/\r?\n/)) {
    const m = RECORD.exec(line.trim());
    if (!m) continue;
    try {
      const data = JSON.parse(m[1]) as { key?: unknown; result?: ProofResult };
      if (data.key === key && data.result && Array.isArray(data.result.items)) return data.result;
    } catch {
      // a damaged record is just not found
    }
  }
  return undefined;
}

/** Appends a proof once: the same key already stored leaves the text exactly as it is (`appended: false`). */
export function appendProofRecord(
  notes: string,
  key: string,
  result: ProofResult
): { text: string; appended: boolean } {
  if (findProofRecord(notes, key)) return { text: notes, appended: false };
  const entry = composeProofRecord(key, result);
  const base = notes.replace(/\s+$/, "");
  return { text: base ? `${base}\n\n${entry}\n` : `${entry}\n`, appended: true };
}
