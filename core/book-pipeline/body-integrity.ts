/**
 * Has the reader's hand been on a picture-book chapter since the program last wrote it? The program stores, in the hidden record
 * `<!-- book-body:v1 {"fp":"…"} -->` of the chapter's work callout, the fingerprint of the chapter as it left the program. The integrity
 * text behind it keeps the chapter text, its pictures, captions and sources; it leaves out only what the program itself owns (the hidden
 * `[!vam-book]` callouts, the trial and review boxes with their markers) and the reader's note wrappers (see book-notes), and a line
 * break is not an edit (CRLF and LF are the same). Typing never refreshes the fingerprint, so it counts as a hand edit; applying notes (the
 * AI's rewrite) and undoing that apply are program writes and refresh it when the chapter was untouched before.
 *
 * Every program write that changes the text stores the new fingerprint in the same write ({@link stampDetail}); a later program
 * transform ({@link programStamp}) refreshes it only when the text it starts from still carries its own fingerprint.
 */
import { projectProofBody } from "./book-notes";
import { latestSlotsRecord, shortHash, stripImageLines } from "./image-slots";
import {
  chapterBody,
  detailBlockOf,
  extractProofRecords,
  fencedLines,
  hasHiddenCallout,
  replaceResearchRecord,
  withoutHiddenCallouts
} from "./note-sections";
import { hashText } from "./text";

const BODY_LINE = /^(?:[ \t]{0,3}>[ \t]?)*<!-- book-body:v1 (\{.*\}) -->$/;

/** What the hidden record holds: the fingerprint of the chapter as the program wrote it, and the one the reader chose to keep. */
export interface BodyRecord {
  /** Absent when the reader kept an older note that never had a program fingerprint: the state then stays "unknown", never "clean". */
  fp?: string;
  /** The fingerprint of the text the reader chose "keep my version" for. */
  kept?: string;
}

const OPEN_ITEMS_LINE = /^\s*<!--\s*aim-open-items\s+\[[^\n]*\]\s*-->\s*$/;
/** The text the fingerprint is made of, from a Detail (the text between the managed markers). */
export function integrityText(detail: string): string {
  const lines = withoutHiddenCallouts(detail.replace(/\r\n/g, "\n").split("\n"));
  // The AIM open-items marker is no chapter text: the card reader appends it to the Detail when it is saved after the block, the raw
  // Detail block does not hold it. Left out here, every caller (card Detail or raw block) gets the same fingerprint.
  const fenced = fencedLines(lines);
  const text = lines.filter((line, at) => fenced[at] || !OPEN_ITEMS_LINE.test(line)).join("\n");
  return projectProofBody(text).trim();
}
export const integrityFp = (detail: string): string => hashText(integrityText(detail));

/** The latest valid record of a Detail; undefined when none. */
export function readBodyRecord(detail: string): BodyRecord | undefined {
  const lines = detail.split("\n");
  const fenced = fencedLines(lines);
  let found: BodyRecord | undefined;
  lines.forEach((line, at) => {
    const m = fenced[at] ? null : BODY_LINE.exec(line.replace(/\r$/, "").trim());
    if (!m) return;
    try {
      const data = JSON.parse(m[1]) as { fp?: unknown; kept?: unknown };
      const fp = typeof data.fp === "string" && /^[0-9a-f]{16}$/.test(data.fp) ? data.fp : undefined;
      const kept = typeof data.kept === "string" && /^[0-9a-f]{16}$/.test(data.kept) ? data.kept : undefined;
      if (!fp && !kept) return;
      found = {
        ...(fp ? { fp } : {}),
        ...(typeof data.kept === "string" && /^[0-9a-f]{16}$/.test(data.kept) ? { kept: data.kept } : {})
      };
    } catch {
      // a damaged record is no record
    }
  });
  return found;
}

const PROOF_KEY_LINE = /^<!-- book-proof:v1 (\{.*\}) -->$/;
const IMAGE_URL = /!\[[^\]\n]*\]\((https:\/\/[^)\s]+)\)/g;

/**
 * An older note (written before the fingerprint existed) with text and no record: it counts as untouched only when two records the program
 * already stored still fit it. The stored proof's text hash must equal the hash of the chapter text as it is now (the text without pictures
 * and captions), and the pictures in the text must be the ones the `book-slots` record lists by hash (no more, no fewer). The caption lines
 * themselves have no stored hash, so a caption edit alone is not seen here. Anything else: unknown (possibly edited).
 */
export function oldNoteLooksUntouched(detail: string, cardDetail: string = detail.trim()): boolean {
  const proofKeys = extractProofRecords(detail)
    .map(record => PROOF_KEY_LINE.exec(record.split("\n").pop() ?? ""))
    .flatMap(m => {
      try {
        const key = (JSON.parse(m?.[1] ?? "") as { key?: unknown }).key;
        return typeof key === "string" ? [key] : [];
      } catch {
        return [];
      }
    });
  const latest = proofKeys[proofKeys.length - 1]?.replace(/:failed$/, "");
  if (!latest) return false;
  const parts = latest.split(":");
  if (parts.length < 5) return false;
  const stored = parts[parts.length - 2];
  // The proof step hashed the Detail as the card reader gives it (trimmed, plus an open-items marker saved after the block); the same here.
  if (stored !== hashText(projectProofBody(stripImageLines(chapterBody(cardDetail))))) return false;
  const placed = (latestSlotsRecord(detail)?.slots ?? [])
    .filter(slot => slot.state === "placed" && slot.hash)
    .map(slot => slot.hash as string)
    .sort();
  const inText = [...integrityText(detail).matchAll(IMAGE_URL)].map(m => shortHash(m[1])).sort();
  return placed.length === inText.length && placed.every((hash, at) => hash === inText[at]);
}

/**
 * empty: no chapter text at all (nothing to lose); clean: the text is as the program left it; edited: the text differs from the stored
 * fingerprint; unknown: text, no fingerprint, and the older records ({@link oldNoteLooksUntouched}) do not fit it: possibly edited,
 * handled like edited by every automatic flow. Text with no record of any kind (no body record, no stored proof, no slots record) is
 * "clean" only when the pipeline itself wrote this chapter before (`wrote`, see {@link pipelineWroteRaw}): an older build's chapter is
 * rewritten after the usual backup (owner decision 2026-11-20). A card the pipeline never wrote that already has text (the reader's own
 * research, say) stays "unknown": it is skipped with the review box, never rewritten without asking (owner requirement, both hold).
 * `cardDetail` is the Detail as the card reader gives it (see {@link cardDetailOf}); only the older-note fallback uses it.
 */
export type BodyState = "empty" | "clean" | "edited" | "unknown";
export function bodyState(detail: string, cardDetail?: string, wrote: boolean = hasHiddenCallout(detail)): BodyState {
  const record = readBodyRecord(detail);
  if (!record?.fp) {
    if (!integrityText(detail)) return "empty";
    if (wrote && !record && !extractProofRecords(detail).length && !latestSlotsRecord(detail)) return "clean";
  }
  return vouched(detail, cardDetail) ? "clean" : record?.fp ? "edited" : "unknown";
}
/** The text still carries the program's own fingerprint, or (an older note) the older records vouch for it. Text with no record is not vouched for. */
function vouched(detail: string, cardDetail?: string): boolean {
  const fp = readBodyRecord(detail)?.fp;
  return fp ? fp === integrityFp(detail) : !!integrityText(detail) && oldNoteLooksUntouched(detail, cardDetail);
}
/** Whether the program may rewrite the text without asking: it is as the program left it, or there is none. */
export const isUntouched = (detail: string): boolean => {
  const state = bodyState(detail);
  return state === "clean" || state === "empty";
};
/** The reader chose "keep my version" for the text as it is now. */
export const isKept = (detail: string): boolean => {
  const record = readBodyRecord(detail);
  return !!record?.kept && record.kept === integrityFp(detail);
};

const compose = (record: BodyRecord): string => `<!-- book-body:v1 ${JSON.stringify(record)} -->`;

/** `detail` with the record set to its own fingerprint (the program just wrote this text). A kept choice does not survive a new text. */
export function stampDetail(detail: string): string {
  const fp = integrityFp(detail);
  const old = readBodyRecord(detail);
  if (old && old.fp === fp && !old.kept) return detail;
  return replaceResearchRecord(detail, compose({ fp }));
}

/** `detail` with the reader's "keep" for the text as it is now (the stored program fingerprint stays, or is absent for an older note). */
export function keepDetail(detail: string): string {
  const old = readBodyRecord(detail);
  const kept = integrityFp(detail);
  if (old?.kept === kept) return detail;
  return replaceResearchRecord(detail, compose({ ...(old?.fp ? { fp: old.fp } : {}), kept }));
}

/**
 * A later program change of the text (a failed picture swapped out, a slot filled, notes applied or that apply undone): the stored
 * fingerprint follows only when the text it started from still equalled it (or, an older note, its older records vouched for it). Otherwise
 * the record is left as it is and the chapter stays "hand-edited"; text with no record stays without one.
 */
export function programStamp(baseDetail: string, nextDetail: string): string {
  return vouched(baseDetail) ? stampDetail(nextDetail) : nextDetail;
}

// ---- the same on a note's whole raw text (the Detail block is where the record lives) ----

/** The AIM open-items marker the card reader (repository `detailWithOpenItems`) appends to the Detail when it is saved after the block. */
const OPEN_ITEMS_MARKER = /\n*^<!--\s*aim-open-items\s+\[[^\n]*\]\s*-->[ \t]*$/m;
const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";
/** The Detail of a note's raw text as the card reader gives it (what the proof step hashed): trimmed, plus an open-items marker saved after it. */
export function cardDetailOf(raw: string): string | undefined {
  const block = detailBlockOf(raw);
  if (block === undefined) return undefined;
  const detail = block.trim();
  if (OPEN_ITEMS_MARKER.test(detail)) return detail;
  const end = raw.indexOf(DETAIL_END, raw.indexOf(DETAIL_START) + 1);
  const after = raw.slice(end + DETAIL_END.length);
  const next = after.search(/^## /m);
  const marker = OPEN_ITEMS_MARKER.exec(next >= 0 ? after.slice(0, next) : after)?.[0].trim();
  return marker ? `${detail}\n\n${marker}` : detail;
}

const spliceDetail = (raw: string, change: (detail: string) => string): string => {
  const detail = detailBlockOf(raw);
  if (detail === undefined) return raw;
  const at = raw.indexOf(detail);
  const next = change(detail);
  return next === detail ? raw : `${raw.slice(0, at)}${next}${raw.slice(at + detail.length)}`;
};
export const stampRaw = (raw: string): string => spliceDetail(raw, stampDetail);
export const keepRaw = (raw: string): string => spliceDetail(raw, keepDetail);
export function programStampRaw(baseRaw: string, nextRaw: string): string {
  const base = detailBlockOf(baseRaw);
  return base !== undefined && vouched(base, cardDetailOf(baseRaw)) ? stampRaw(nextRaw) : nextRaw;
}
export const isKeptRaw = (raw: string): boolean => isKept(detailBlockOf(raw) ?? "");
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
/** Only the pipeline's proofread sets these stages, and only on a chapter it wrote (a skipped chapter gets planned or needs-review). */
const WRITTEN_STAGE = /^pipeline-stage:[ \t]*["']?(?:written|checked)["']?[ \t]*\r?$/m;
/**
 * Evidence, in a note's raw text, that the pipeline itself wrote this chapter at some time: one of its hidden `[!vam-book]` callouts (work
 * records, proofread result), or a `written`/`checked` stage. Fields the plan writes on every card of a run (`book-role`, `pipeline-role`)
 * and the owner's role choice (`book-role-by`) are no such evidence: they are there before a single word was written.
 */
export function pipelineWroteRaw(raw: string): boolean {
  if (hasHiddenCallout(raw)) return true;
  const fm = FRONTMATTER.exec(raw)?.[1];
  return !!fm && WRITTEN_STAGE.test(fm);
}
export const bodyStateRaw = (raw: string): BodyState =>
  bodyState(detailBlockOf(raw) ?? "", cardDetailOf(raw), pipelineWroteRaw(raw));
export const integrityFpRaw = (raw: string): string => integrityFp(detailBlockOf(raw) ?? "");

// ---- whose chapter text this is (product glossary: 章節文字歸屬) ----

/** What lets the program rewrite a chapter text the reader holds: the card's own rerun, or a one-time permit bound to a fingerprint. */
export interface RewriteAllowance {
  /** The reader asked for this card's rerun: a kept text the program wrote itself (clean or empty) may be rewritten. */
  rerun?: boolean;
  /** The fingerprint a one-time permit was given for (only for the current run); it holds while the text still has it. */
  permit?: string;
}

/**
 * Whether the program may rewrite this chapter text without asking: the text is the program's (clean or empty) and the reader has not
 * kept it. A kept text the program wrote itself is open to the card's own rerun; any text is open to a permit for exactly this text.
 */
export function mayRewriteRaw(raw: string, allow: RewriteAllowance = {}): boolean {
  const state = bodyStateRaw(raw);
  if ((state === "clean" || state === "empty") && (!isKeptRaw(raw) || allow.rerun)) return true;
  return !!allow.permit && allow.permit === integrityFpRaw(raw);
}

/**
 * Whether the card's Summary is the reader's own, so a plan change keeps it: the reader kept a text that is not the program's untouched
 * one, or the card has text from before the book (unknown, and the pipeline never wrote it).
 */
export function readerSummaryRaw(raw: string): boolean {
  const state = bodyStateRaw(raw);
  return (isKeptRaw(raw) && state !== "clean") || (state === "unknown" && !pipelineWroteRaw(raw));
}

/** The reader kept a text that has been edited since: the keep no longer holds, and the hand-edit question is asked again. */
export const keepVoided = (detail: string): boolean => !!readBodyRecord(detail)?.kept && !isKept(detail);
