import { t } from "../../i18n";
import type { PipelineStage } from "../../core/book-pipeline/model";
import { describeSlots, latestSlotsRecord } from "../../core/book-pipeline/image-slots";
import {
  chapterBody,
  fencedLines,
  programCalloutRanges,
  type ProgramCallout,
  type StoredProofView
} from "../../core/book-pipeline/note-sections";
import { parseImageSlots } from "../../core/book-pipeline/plan-text";
import { escapeMarkdownText, hashText, unescapeMarkdownText } from "../../core/book-pipeline/text";
import { bookIssueText } from "./book-pipeline-ui";
import { bodyImageUrls } from "./book-pipeline-run";

export { countNotes, projectProofBody, wrapNote } from "../../core/book-pipeline/book-notes";

/**
 * The review core of the picture-book pipeline, pure text in and out: which chapters need a look (the rules the gate 2 panel used),
 * the fingerprint of that need, the two callouts the program writes at the top of a chapter's Detail (a trial hint, a review box) and
 * the reading and editing of them in a note's raw text. Everything from a note or the model is turned into plain text first; only the
 * program writes a callout, a checkbox or a link. The callouts carry their own owner marker, so an author's look-alike is never touched.
 */

export interface Gate2Card {
  id: string;
  index: number;
  title: string;
  stage: PipelineStage | "pending";
  role?: string;
  /** The plain sentence of a needs-review card (never a code). */
  failureText?: string;
  /** Checked cards: structure items the proofreader found unmet (picture tokens are not counted). */
  structureUnmet: number;
  /** Checked cards: fact items that were not confirmed against a source. */
  factsOpen: number;
  /** A gallery chapter whose every picture slot ended without a picture: its content is missing. */
  galleryBare: boolean;
  /** A neighbouring card changed and the owner has not confirmed the join. */
  seam: boolean;
}

/** The input shape `galleryBare` reads from a card note. */
interface GalleryNote {
  prompt?: string;
  detail?: string;
}

/**
 * The one place that decides whether a chapter is "fine": every reason below keeps the card in the attention list and keeps the
 * panel from saying "all done". A needs-review or unfinished card, unmet structure items, facts not confirmed, a gallery chapter
 * with no picture at all, and a join not yet confirmed all count. A slot that found no picture in an ordinary chapter does not: the
 * chapter simply has fewer pictures (its text still stands).
 */
export function attentionReasons(card: Gate2Card): string[] {
  const out: string[] = [];
  if (card.stage === "needs-review") out.push(card.failureText || t("ui.book_issue_unknown"));
  else if (card.stage !== "checked") out.push(t("ui.book_panel_g2_reason_unfinished"));
  if (card.structureUnmet > 0) out.push(t("ui.book_panel_g2_reason_structure_0", card.structureUnmet));
  if (card.factsOpen > 0) out.push(t("ui.book_panel_g2_reason_facts_0", card.factsOpen));
  if (card.galleryBare) out.push(t("ui.book_panel_g2_reason_images"));
  if (card.seam) out.push(t("ui.book_panel_g2_reason_seam"));
  return out;
}
export const needsAttention = (card: Gate2Card): boolean => attentionReasons(card).length > 0;

/** Codes the proofreader may have copied into its notes (C1, N2) are not for the reader. */
export const plainNote = (text: string): string =>
  text
    .replace(/\b[CN]\d+\b\s*[:：]?/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The reason of a needs-review card in words: the proof's own notes of the items not met, else the count, else a plain sentence; never a code. */
export function reasonOf(issue: string, proof: StoredProofView | undefined): string {
  if (!/^proof unmet/.test(issue.trim())) return bookIssueText(issue);
  if (/facts_unverified/.test(issue)) return t("ui.book_reason_all_facts_unverified");
  const open = (proof?.items ?? []).filter(item => item.status !== "met");
  const notes = [...new Set(open.map(item => plainNote(unescapeMarkdownText(item.note))).filter(Boolean))].slice(0, 3);
  if (notes.length) return notes.join(t("ui.book_panel_lead_sep"));
  return open.length ? t("ui.book_panel_reason_unchecked_0", open.length) : t("ui.book_panel_reason_unmet_plain");
}

/** Whether the chapter's pictures are a hole in a gallery chapter (uses the stored slot record and the picture addresses now in the text). */
export function galleryBare(role: string | undefined, note: GalleryNote | undefined): boolean {
  if (role !== "gallery") return false;
  const slots = parseImageSlots(note?.prompt ?? "") ?? [];
  if (!slots.length) return false;
  const detail = note?.detail ?? "";
  const states = describeSlots(slots, latestSlotsRecord(detail), bodyImageUrls(chapterBody(detail)));
  return (
    states.some(slot => slot.state === "missing") &&
    !states.some(slot => slot.state === "placed" || slot.state === "edited")
  );
}

/** What makes a chapter's attention "the same one": a new stage, issue, proof or neighbour change is a new need, so an earlier tick no longer counts. */
export interface AttentionFpInput {
  stage: string;
  /** `pipelineIssue` as stored (codes, not shown to the reader). */
  issue?: string;
  /** The key of the card's latest stored proof. */
  proofKey?: string;
  /** The full `pipelineSeam` value (source chapter and revision), not only whether there is one. */
  seam?: string;
}
export const attentionFingerprint = (input: AttentionFpInput): string =>
  hashText(JSON.stringify([input.stage, input.issue ?? "", input.proofKey ?? "", input.seam ?? ""]));

// ---- plain text and links ----

/**
 * Untrusted text as plain text for a callout line: the note-text allow-list (no HTML, callout, `%%`, list, heading, link or image syntax can
 * form), `=` made full-width (no `==` highlight) and a web address broken so it is not turned into a link.
 */
export const plainText = (value: unknown, max = 300): string =>
  escapeMarkdownText(value, max).replace(/=/g, "＝").replace(/:\/\//g, ":／／");

/** A chapter the callout links to: the note path (the link target) and its title. */
export interface BookNoteLink {
  path: string;
  title: string;
}
const linkPart = (value: string, max: number): string =>
  Array.from(
    value
      .replace(/[\p{Cc}[\]|#^\\<>%=]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  )
    .slice(0, max)
    .join("");
const noteLink = (link: BookNoteLink | undefined): string => {
  const path = link ? linkPart(link.path.replace(/\.md$/i, ""), 200) : "";
  if (!link || !path) return "";
  const title = linkPart(link.title, 60);
  return title ? `[[${path}|${title}]]` : `[[${path}]]`;
};
const idPart = (value: string): string => value.replace(/[^\w.-]/g, "");

// ---- the callouts ----

const VERSION_LINE = "> %%vam-callout-version:1%%";
const quoted = (lines: string[]): string => lines.join("\n");
type LinkKey = "ui.book_note_prev_0" | "ui.book_note_next_0" | "ui.book_note_review_next_0";
const linksLine = (pairs: [LinkKey, BookNoteLink | undefined][]): string | undefined => {
  const parts = pairs.map(([key, link]) => ({ key, link: noteLink(link) })).filter(part => part.link);
  return parts.length ? `> ${parts.map(part => t(part.key, part.link)).join("　")}` : undefined;
};

/** The hint at the top of a trial chapter: where it is in the trial, what to do next, links to the neighbours; while stopped it says to press Continue first. */
export function trialCallout(
  i: number,
  n: number,
  prevLink: BookNoteLink | undefined,
  nextLink: BookNoteLink | undefined,
  stopped: boolean | undefined,
  owner: { runId: string; nodeId: string }
): string {
  const links = linksLine([
    ["ui.book_note_prev_0", prevLink],
    ["ui.book_note_next_0", nextLink]
  ]);
  return quoted([
    `> [!vam-trial] ${t("ui.book_note_trial_title_0", i, n)}`,
    `> ${stopped ? t("ui.book_note_trial_stopped") : t("ui.book_note_trial_next")}`,
    ...(links ? [links] : []),
    `> %%vam-trial:${idPart(owner.runId)}:${idPart(owner.nodeId)}%%`,
    VERSION_LINE
  ]);
}

/** The box at the top of a chapter that needs a look: the reasons as plain text, the two checkboxes, a link to the next one. */
export function reviewCallout(
  card: Pick<Gate2Card, "id" | "title">,
  reasons: readonly string[],
  nextLink: BookNoteLink | undefined,
  fp: string,
  runId: string
): string {
  const next = linksLine([["ui.book_note_review_next_0", nextLink]]);
  return quoted([
    `> [!vam-review] ${t("ui.book_note_review_title")}`,
    ...reasons.slice(0, 5).map(reason => `> ・${plainText(reason)}`),
    `> - [ ] ${t("ui.book_note_review_accept")}`,
    `> - [ ] ${t("ui.book_note_review_fixed")}`,
    ...(next ? [next] : []),
    `> %%vam-review:${idPart(runId)}:${idPart(card.id)}:${idPart(fp)}%%`,
    VERSION_LINE
  ]);
}

// ---- reading and editing a note's raw text ----

const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";
const CHECKBOX = /^[ \t]{0,3}>[ \t]?[-*+][ \t]+\[([ xX])\]/;
const REVIEW_SIGN = /\[!vam-review\][+-]?/i;
const bare = (line: string): string => line.replace(/\r$/, "");

/** The line span of the Detail block (the lines between its markers), or undefined when the text has none. */
function detailSpan(lines: string[]): { from: number; to: number } | undefined {
  const from = lines.findIndex(line => bare(line).trim() === DETAIL_START);
  if (from < 0) return undefined;
  let to = -1;
  for (let i = lines.length - 1; i > from; i--) {
    if (bare(lines[i]).trim() === DETAIL_END) {
      to = i;
      break;
    }
  }
  return to < 0 ? undefined : { from, to };
}

/** The program's callouts inside the Detail block of a raw note text (only marked ones; an author's look-alike is not listed). */
function ownedIn(lines: string[]): ProgramCallout[] {
  const span = detailSpan(lines);
  if (!span) return [];
  return programCalloutRanges(lines, fencedLines(lines)).filter(c => c.start > span.from && c.end <= span.to);
}
export const findProgramCallouts = (text: string): ProgramCallout[] => ownedIn(text.split("\n"));

/** The text without the program's callouts of `kind` (all kinds when omitted), each with the one blank line it brought. Nothing else changes. */
export function removeProgramCallouts(text: string, kind?: "trial" | "review"): string {
  const lines = text.split("\n");
  const drop = ownedIn(lines).filter(c => !kind || c.kind === kind);
  if (!drop.length) return text;
  const gone = new Set<number>();
  for (const c of drop) {
    for (let i = c.start; i < c.end; i++) gone.add(i);
    if (c.end < lines.length && !bare(lines[c.end]).trim()) gone.add(c.end);
  }
  return lines.filter((_, i) => !gone.has(i)).join("\n");
}

/**
 * `callout` (a {@link trialCallout} or {@link reviewCallout} text) at the top of the Detail block, replacing the program's callouts of the
 * same kind. Running it twice with the same callout gives the same text. A text without a Detail block, or a callout of no known kind,
 * comes back unchanged.
 */
export function putProgramCallout(text: string, callout: string): string {
  const head = /^>[ \t]?\[!vam-(trial|review)\]/i.exec(callout);
  const kind = head ? (head[1].toLowerCase() === "trial" ? "trial" : "review") : undefined;
  if (!kind || !detailSpan(text.split("\n"))) return text;
  const cleared = removeProgramCallouts(text, kind);
  const lines = cleared.split("\n");
  const span = detailSpan(lines);
  if (!span) return text;
  const cr = text.includes("\r\n") ? "\r" : "";
  const block = [...callout.split("\n").map(line => line + cr), cr];
  return [...lines.slice(0, span.from + 1), ...block, ...lines.slice(span.from + 1)].join("\n");
}

/** The review box folded (`[!vam-review]-`): the ticks and the marker stay. Already folded, or no review box: the text comes back unchanged. */
export function collapseReviewCallouts(text: string): string {
  const lines = text.split("\n");
  let changed = false;
  for (const c of ownedIn(lines)) {
    if (c.kind !== "review" || c.sign === "-") continue;
    lines[c.start] = lines[c.start].replace(REVIEW_SIGN, "[!vam-review]-");
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}

export interface ReviewState {
  runId: string;
  nodeId: string;
  fp: string;
  accept: boolean;
  fixed: boolean;
  collapsed: boolean;
}

/** The review box of a note as it stands: its marker and which of its two boxes are ticked; undefined when the note has none. */
export function readReviewState(text: string): ReviewState | undefined {
  const lines = text.split("\n");
  const box = ownedIn(lines).find(c => c.kind === "review" && c.fp);
  if (!box) return undefined;
  const ticks: boolean[] = [];
  for (let i = box.start + 1; i < box.end; i++) {
    const m = CHECKBOX.exec(bare(lines[i]));
    if (m) ticks.push(m[1] !== " ");
  }
  return {
    runId: box.runId,
    nodeId: box.nodeId,
    fp: box.fp ?? "",
    accept: ticks[0] === true,
    fixed: ticks[1] === true,
    collapsed: box.sign === "-"
  };
}

/** Handled: one of the two boxes is ticked and the box was written for the chapter's attention as it is now (a changed fingerprint voids the tick). */
export const isReviewResolved = (state: ReviewState | undefined, fp: string): boolean =>
  !!state && (state.accept || state.fixed) && state.fp === fp;
