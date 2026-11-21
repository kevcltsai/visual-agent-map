/**
 * The independent AI proofreader's contract: what its reply may say, what the program keeps of it, and what is still open after a
 * round. Pure. The reply is untrusted: only whitelisted kinds and verdicts survive, a quote must stand word for word in the text it
 * claims to quote (otherwise the whole item is dropped and never counted in N), sources are only addresses the chapter lists (and
 * this call opened), and every text field is one plain line. The call itself is `core/steps/book-pipeline/ai-proof.ts`; the in-place
 * fix is `ai-fix.ts`; the closing page is `open-issues.ts`.
 */
import { verbatimQuote } from "./cross-checks";
import { stripImageLines } from "./image-slots";
import { projectProofBody } from "./book-notes";
import { chapterBody } from "./note-sections";
import { safeHref } from "./proof";
import { hashText, singleLine } from "./text";

export const AI_PROOF_MAX_ITEMS = 40;
export const AI_QUOTE_MAX = 300;
export const AI_TEXT_MAX = 300;
export const AI_CHECK_KINDS = ["fact", "number", "consistency", "citation"] as const;
export type AiCheckKind = (typeof AI_CHECK_KINDS)[number];
export const AI_VERDICTS = ["ok", "problem", "unverifiable"] as const;
export type AiVerdict = (typeof AI_VERDICTS)[number];
/** Why the proofreader says a problem cannot be fixed by editing the text. */
export const AI_UNFIXABLE_WHY = ["sources_conflict", "source_unreachable"] as const;
export type AiUnfixableWhy = (typeof AI_UNFIXABLE_WHY)[number];

/** Why an item is still open, as a neutral code (the screen turns it into a plain sentence). */
export const AI_OPEN_REASONS = [
  "still_present",
  "sources_conflict",
  "source_unreachable",
  "unfixable",
  "fix_refused_picture",
  "fix_refused_length",
  "fix_quote_missing",
  "fix_forbidden_syntax",
  "hand_edited",
  "fix_failed",
  "proof_incomplete",
  "not_fixed_in_time",
  "not_fixed"
] as const;
export type AiOpenReason = (typeof AI_OPEN_REASONS)[number];

/** One entry of the reply as the step parser read it: types coerced, nothing judged yet. */
export interface RawAiCheck {
  id: string;
  kind: string;
  quote: string;
  verdict: string;
  problem: string;
  fixable: boolean;
  why: string;
  suggestion: string;
  sources: string[];
  /** Whole-book replies only: the 1-based chapter the quote is from, and the chapter it contradicts. */
  chapter?: number;
  otherChapter?: number;
}
export interface RawAiProof {
  checks: RawAiCheck[];
  prior: { id: string; status: string }[];
}

export interface AiCheck {
  id: string;
  kind: AiCheckKind;
  /** Word for word from the text (never escaped: it is what an edit is matched against). Escape it before it goes into a note. */
  quote: string;
  verdict: AiVerdict;
  problem: string;
  fixable: boolean;
  why?: AiUnfixableWhy;
  suggestion: string;
  sources: string[];
  chapter?: number;
  otherChapter?: number;
}
export type AiCheckState = "ok" | "fixable" | "unfixable" | "unverifiable";

export interface AiDropped {
  kind: number;
  verdict: number;
  quote: number;
  invalid: number;
  duplicate: number;
  /** Kept checks cut because there were more than the limit. */
  truncated: number;
}
export interface AiProofReview {
  /** The kept checks; N is `checks.length`. */
  checks: AiCheck[];
  prior: { id: string; status: "resolved" | "still" }[];
  dropped: AiDropped;
}

export interface AiReviewInput {
  /** The text the quotes are checked against: one chapter, or (whole book) every chapter in order, so `chapter` 1 is the first. */
  body: string | readonly string[];
  /** Addresses the chapter lists; a cited source outside them is dropped. */
  allowedSources?: readonly string[];
  /** When given, a cited source must also be one this call opened. */
  openedUrls?: readonly string[];
  maxItems?: number;
}

const oneOf = <T extends string>(list: readonly T[], value: string): value is T =>
  (list as readonly string[]).includes(value);
const validChapter = (value: unknown, chapters: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= chapters;

/** The text a chapter is proofread on: prose only (pictures with captions and the reader's notes are not claims). */
export const aiProofBody = (chapter: string): string => projectProofBody(stripImageLines(chapter)).trim();

/** What the verdict was asked for: the card's revision and its text. A hand edit or a rewrite changes it, so a late reply for the old text is dropped. */
export const aiProofKey = (revision: number, body: string): string => `${revision}:${hashText(body)}`;

export function reviewAiProof(raw: RawAiProof, input: AiReviewInput): AiProofReview {
  const limit = input.maxItems ?? AI_PROOF_MAX_ITEMS;
  const chapters = typeof input.body === "string" ? [input.body] : [...input.body];
  const book = typeof input.body !== "string";
  const allowed = new Set((input.allowedSources ?? []).map(safeHref).filter((href): href is string => !!href));
  const opened = input.openedUrls && new Set(input.openedUrls.map(safeHref).filter((href): href is string => !!href));
  const dropped: AiDropped = { kind: 0, verdict: 0, quote: 0, invalid: 0, duplicate: 0, truncated: 0 };
  const seen = new Set<string>();
  const kept: AiCheck[] = [];
  for (const entry of raw.checks) {
    const id = singleLine(entry.id, 20);
    if (!id) {
      dropped.invalid++;
      continue;
    }
    if (seen.has(id)) {
      dropped.duplicate++;
      continue;
    }
    if (!oneOf(AI_CHECK_KINDS, entry.kind)) {
      dropped.kind++;
      continue;
    }
    if (!oneOf(AI_VERDICTS, entry.verdict)) {
      dropped.verdict++;
      continue;
    }
    const at = book ? entry.chapter : 1;
    if (!validChapter(at, chapters.length)) {
      dropped.invalid++;
      continue;
    }
    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (
      !quote ||
      quote.length > AI_QUOTE_MAX ||
      /[\r\n]/.test(quote) ||
      verbatimQuote(quote, chapters[at - 1]) !== quote
    ) {
      dropped.quote++;
      continue;
    }
    const problem = singleLine(entry.problem, AI_TEXT_MAX);
    if (entry.verdict === "problem" && !problem) {
      dropped.invalid++;
      continue;
    }
    seen.add(id);
    const why = oneOf(AI_UNFIXABLE_WHY, entry.why) ? entry.why : undefined;
    const sources: string[] = [];
    for (const source of entry.sources) {
      const href = safeHref(source);
      if (!href || sources.includes(href)) continue;
      if (input.allowedSources && !allowed.has(href)) continue;
      if (opened && !opened.has(href)) continue;
      sources.push(href);
    }
    // A chapter that lists no sources gave the model nothing to check a fact or a number against: its "ok" is not a verification.
    const verdict: AiVerdict =
      entry.verdict === "ok" && input.allowedSources?.length === 0 && (entry.kind === "fact" || entry.kind === "number")
        ? "unverifiable"
        : entry.verdict;
    const other =
      book && validChapter(entry.otherChapter, chapters.length) && entry.otherChapter !== at
        ? entry.otherChapter
        : undefined;
    kept.push({
      id,
      kind: entry.kind,
      quote,
      verdict,
      problem,
      fixable: entry.verdict === "problem" && entry.fixable === true && !why,
      ...(why ? { why } : {}),
      suggestion: singleLine(entry.suggestion, AI_TEXT_MAX),
      sources: sources.slice(0, 5),
      ...(book ? { chapter: at } : {}),
      ...(other ? { otherChapter: other } : {})
    });
  }
  if (kept.length > limit) {
    dropped.truncated = kept.length - limit;
    kept.length = limit;
  }
  const prior = raw.prior
    .filter(entry => entry.status === "resolved" || entry.status === "still")
    .map(entry => ({ id: singleLine(entry.id, 20), status: entry.status as "resolved" | "still" }))
    .filter(entry => entry.id);
  return { checks: kept, prior, dropped };
}

export function checkState(check: AiCheck): AiCheckState {
  if (check.verdict === "ok") return "ok";
  if (check.verdict === "unverifiable") return "unverifiable";
  return check.fixable ? "fixable" : "unfixable";
}

/** The problem a fix is asked to repair. */
export interface AiFixTarget {
  id: string;
  quote: string;
  problem: string;
  suggestion: string;
  chapter?: number;
}
export const fixTargetsOf = (checks: readonly AiCheck[]): AiFixTarget[] =>
  checks
    .filter(check => checkState(check) === "fixable")
    .map(check => ({
      id: check.id,
      quote: check.quote,
      problem: check.problem,
      suggestion: check.suggestion,
      ...(check.chapter ? { chapter: check.chapter } : {})
    }));

/** What was left open from the previous round, as the next check is told (never the program's own findings). */
export interface AiPriorIssue {
  id: string;
  quote: string;
  problem: string;
  chapter?: number;
}
export const priorOf = (targets: readonly AiFixTarget[]): AiPriorIssue[] =>
  targets.map(target => ({
    id: target.id,
    quote: target.quote,
    problem: target.problem,
    ...(target.chapter ? { chapter: target.chapter } : {})
  }));

const compact = (text: string): string => text.replace(/\s+/g, "");

export interface AiRoundDiff {
  /** Prior problems that are gone. */
  resolved: AiPriorIssue[];
  /** Prior problems the new check still reports (by the quote, not by the model's word: the program decides). */
  still: AiPriorIssue[];
  /** Problems the new check reports that were not open before. */
  fresh: AiCheck[];
}
/**
 * Compares a re-check with the problems left open. A prior problem is still there when the new check reports a problem on the same quote
 * (ids may be renumbered, so the quote decides), or when the model says "still" and the quote still stands in the text; a model's
 * "resolved" does not override a problem it reports again.
 */
export function compareRounds(
  prior: readonly AiPriorIssue[],
  next: AiProofReview,
  body: string | readonly string[]
): AiRoundDiff {
  const texts = (typeof body === "string" ? [body] : [...body]).map(compact);
  const reported = next.checks.filter(check => check.verdict === "problem");
  const matched = new Set<string>();
  const resolved: AiPriorIssue[] = [];
  const still: AiPriorIssue[] = [];
  for (const issue of prior) {
    const hit = reported.find(check => compact(check.quote) === compact(issue.quote) && !matched.has(check.id));
    const said = next.prior.find(entry => entry.id === issue.id)?.status === "still";
    const standing = texts[(issue.chapter ?? 1) - 1]?.includes(compact(issue.quote)) ?? false;
    if (hit) {
      matched.add(hit.id);
      still.push(issue);
    } else if (said && standing) still.push(issue);
    else resolved.push(issue);
  }
  return { resolved, still, fresh: reported.filter(check => !matched.has(check.id)) };
}

export interface AiOpenItem {
  id: string;
  chapter?: number;
  quote: string;
  problem: string;
  reason: AiOpenReason;
}
/**
 * What the proofread leaves open once the rounds are over, from the last check. `refused` carries the reason a fix of that id was blocked
 * (a picture would go, the quote was missing, ...); `fixFailed` marks a fix that kept failing. An unfinished proofread is one item
 * (`proof_incomplete`), never a "all solved". A problem the proofreader marked unfixable keeps its own reason; a fixable one still
 * reported after the last round is `still_present`.
 */
export function unresolvedItems(
  last: readonly AiCheck[],
  options: { incomplete?: boolean; refused?: Readonly<Record<string, AiOpenReason>>; fixFailed?: boolean } = {}
): AiOpenItem[] {
  if (options.incomplete) return [{ id: "proof", quote: "", problem: "", reason: "proof_incomplete" }];
  const items: AiOpenItem[] = [];
  for (const check of last) {
    const state = checkState(check);
    if (state !== "fixable" && state !== "unfixable") continue;
    const reason: AiOpenReason =
      state === "unfixable"
        ? (check.why ?? "unfixable")
        : (options.refused?.[check.id] ?? (options.fixFailed ? "fix_failed" : "still_present"));
    items.push({
      id: check.id,
      ...(check.chapter ? { chapter: check.chapter } : {}),
      quote: check.quote,
      problem: check.problem,
      reason
    });
  }
  return items;
}

export interface AiProofSource {
  url: string;
  title: string;
}
const MD_LINK = /(?<!!)\[([^\]\n]*)\]\((https:\/\/[^)\s]+)\)/g;
const SOURCES_HEADING = /^##\s+(?:來源|来源|Sources?)\s*$/;
const PICTURE_CREDIT = /^-\s*(?:圖|图|Image|Figure|Picture)/i;
/**
 * The sources a chapter cites, as the AI proofreader may open them: the text links in the chapter body and the link lines of its Sources
 * section, https only, no duplicates. A picture's credit line (`- 圖「..」`) is not a source of the text. Live chapters mostly carry their
 * sources as links inside the text; the Sources section is often only picture credits or absent.
 */
export function chapterSources(detail: string): AiProofSource[] {
  const out: AiProofSource[] = [];
  const add = (title: string, url: string): void => {
    const href = safeHref(url);
    if (href && !out.some(item => item.url === href)) out.push({ url: href, title: singleLine(title, 200) });
  };
  for (const m of stripImageLines(chapterBody(detail)).matchAll(MD_LINK)) add(m[1], m[2]);
  const lines = detail.replace(/\r\n?/g, "\n").split("\n");
  const from = lines.findIndex(line => SOURCES_HEADING.test(line.trim()));
  if (from >= 0) {
    for (const line of lines.slice(from + 1)) {
      if (/^#{1,6}\s|^\s*>/.test(line)) break;
      if (!/^\s*-\s/.test(line) || PICTURE_CREDIT.test(line.trim())) continue;
      for (const m of line.matchAll(MD_LINK)) add(m[1], m[2]);
    }
  }
  return out;
}
