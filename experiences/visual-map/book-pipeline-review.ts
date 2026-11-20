import { t } from "../../i18n";
import type { PipelineStage } from "../../core/book-pipeline/model";
import {
  describeSlots,
  latestSlotsRecord,
  splitPictureIssue,
  stripImageLines
} from "../../core/book-pipeline/image-slots";
import {
  chapterBody,
  fencedLines,
  findStoredProof,
  latestStoredProof,
  programCalloutRanges,
  type ProgramCallout,
  type StoredProofView
} from "../../core/book-pipeline/note-sections";
import { failedProofKey, proofKey } from "../../core/book-pipeline/proof";
import { parseChecklist, parseImageSlots } from "../../core/book-pipeline/plan-text";
import { escapeMarkdownText, hashText, unescapeMarkdownText } from "../../core/book-pipeline/text";
import { splitLengthIssue } from "../../core/book-pipeline/settings";
import type { ChapterInconsistency } from "../../core/book-pipeline/consistency";
import { bookCardView, bookIssueText, lengthText, pictureIssueText } from "./book-pipeline-ui";
import { bodyImageUrls } from "./book-pipeline-run";

import { projectProofBody } from "../../core/book-pipeline/book-notes";
import { integrityFp, isKept, readBodyRecord } from "../../core/book-pipeline/body-integrity";
import { hasHiddenCallout } from "../../core/book-pipeline/note-sections";

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
  /** With `seam`: the title of the neighbour whose change the seam names (absent when that card is no longer next to this one). */
  seamFrom?: string;
  /** The chapter text changed after its stored proof (the proof no longer fits): shown as "edited, not re-checked". */
  proofStale?: boolean;
  /** The run skipped this chapter because the reader's hand has been on it (the card is needs-review for that reason only). */
  handEdited?: boolean;
  /** With `handEdited`: the text was there before the book (no program fingerprint, no `[!vam-book]` callout); the run did not rewrite it. */
  handBeforeBook?: boolean;
  /** With `handEdited`: the integrity fingerprint of the text the run skipped (the one a rewrite permission is bound to). */
  bodyFp?: string;
  /** What the last whole-book consistency check found for this chapter (absent: nothing, or the chapter changed since). */
  inconsistencies?: (ChapterInconsistency & { otherTitle: string })[];
  /** The card is needs-review only because of the consistency check (issue `consistency`); its findings say why. */
  consistencyOnly?: boolean;
}

/** The input shape `galleryBare` reads from a card note. */
interface GalleryNote {
  prompt?: string;
  detail?: string;
}

/** The kinds of problem a chapter can have. A new kind (a hand-edited chapter, say) is one more entry in {@link PROBLEM_RULES}. */
export type ReviewProblemKind =
  "failed" | "unfinished" | "structure" | "facts" | "images" | "seam" | "edited" | "hand-edited" | "consistency";
export interface ReviewProblem {
  kind: ReviewProblemKind;
  /** The plain sentence the reader sees. */
  text: string;
}
/** In the order the sentences are listed: the first rule that applies to a card comes first. */
/** A rule gives one sentence, or one per finding (the consistency check: each pair of chapters is its own line). */
const PROBLEM_RULES: readonly { kind: ReviewProblemKind; of: (card: Gate2Card) => string | string[] | undefined }[] = [
  {
    kind: "failed",
    of: card =>
      card.stage === "needs-review" && !card.handEdited && !card.consistencyOnly
        ? card.failureText || t("ui.book_issue_unknown")
        : undefined
  },
  {
    kind: "hand-edited",
    of: card =>
      card.handEdited
        ? t(card.handBeforeBook ? "ui.book_review_hand_before_book" : "ui.book_review_hand_edited")
        : undefined
  },
  {
    kind: "consistency",
    of: card =>
      card.inconsistencies?.length
        ? card.inconsistencies.map(item => {
            if (item.kind === "removed") return t("ui.book_reason_removed_ref_0_1", item.theirs, item.own);
            if (item.reference)
              return t("ui.book_reason_chapter_ref_0_1_2_3", item.own, item.theirs, item.otherTitle, item.suggestion);
            const sentence = t("ui.book_reason_inconsistent_0_1_2", item.otherTitle, item.own, item.theirs);
            return item.suggestion ? `${sentence}${t("ui.book_panel_lead_sep")}${item.suggestion}` : sentence;
          })
        : undefined
  },
  {
    kind: "unfinished",
    of: card =>
      card.stage !== "needs-review" && card.stage !== "checked" ? t("ui.book_panel_g2_reason_unfinished") : undefined
  },
  {
    kind: "structure",
    of: card => (card.structureUnmet > 0 ? t("ui.book_panel_g2_reason_structure_0", card.structureUnmet) : undefined)
  },
  {
    kind: "facts",
    of: card => (card.factsOpen > 0 ? t("ui.book_panel_g2_reason_facts_0", card.factsOpen) : undefined)
  },
  { kind: "images", of: card => (card.galleryBare ? t("ui.book_panel_g2_reason_images") : undefined) },
  {
    kind: "seam",
    of: card =>
      card.seam
        ? card.seamFrom
          ? t("ui.book_panel_g2_reason_seam_0", card.seamFrom)
          : t("ui.book_panel_g2_reason_seam")
        : undefined
  },
  { kind: "edited", of: card => (card.proofStale && !card.handEdited ? t("ui.book_stale_proof") : undefined) }
];

/**
 * The one place that decides whether a chapter is "fine": every problem below keeps the card in the attention list and keeps the
 * panel from saying "all done". A needs-review or unfinished card, unmet structure items, facts not confirmed, a gallery chapter
 * with no picture at all, and a join not yet confirmed all count. A slot that found no picture in an ordinary chapter does not: the
 * chapter simply has fewer pictures (its text still stands).
 */
export function reviewProblems(card: Gate2Card): ReviewProblem[] {
  const out: ReviewProblem[] = [];
  for (const rule of PROBLEM_RULES) {
    const found = rule.of(card);
    for (const text of found === undefined ? [] : Array.isArray(found) ? found : [found])
      out.push({ kind: rule.kind, text });
  }
  return out;
}
export const attentionReasons = (card: Gate2Card): string[] => reviewProblems(card).map(problem => problem.text);
export const needsAttention = (card: Gate2Card): boolean => attentionReasons(card).length > 0;

/** Codes the proofreader may have copied into its notes (C1, N2) are not for the reader. */
export const plainNote = (text: string): string =>
  text
    .replace(/\b[CN]\d+\b\s*[:：]?/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The reason of a needs-review card in words: the proof's own notes of the items not met, else the count, else a plain sentence; never a code. */
export function reasonOf(issue: string, proof: StoredProofView | undefined): string {
  const pictures = splitPictureIssue(issue);
  const pictureText = pictureIssueText(pictures);
  if (pictureText)
    return pictures.rest
      ? `${reasonOf(pictures.rest, proof)}${t("ui.book_panel_lead_sep")}${pictureText}`
      : pictureText;
  const { rest, length } = splitLengthIssue(issue);
  if (length) {
    const sentence = lengthText(length);
    return rest ? `${reasonOf(rest, proof)}${t("ui.book_panel_lead_sep")}${sentence}` : sentence;
  }
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

/** The note fields `gate2Cards` reads (a card note as the view holds it). */
export interface Gate2NoteInput {
  prompt?: string;
  detail?: string;
  pipelineStage?: unknown;
  pipelineIssue?: unknown;
  pipelineSeam?: unknown;
  bookRole?: unknown;
}

/** The chapters of the run in reading order as `Gate2Card`s, from their notes (what the gate 2 panel used to build). */
/**
 * The neighbour a seam line names (the run writes "… (card N, revision R)" / "（第 N 張，版本 R）", N the changed card's place then). Named
 * only while that place is still right next to this chapter, so a later reorder never names the wrong chapter (the plain sentence stays).
 */
function seamFromOf(
  seam: unknown,
  order: readonly string[],
  at: number,
  titleOf: (id: string) => string
): { seamFrom?: string } {
  const m = typeof seam === "string" ? /(?:第\s*|card\s+)(\d+)/i.exec(seam) : null;
  const other = m ? Number(m[1]) - 1 : -1;
  if (other !== at - 1 && other !== at + 1) return {};
  const title = order[other] === undefined ? "" : titleOf(order[other]).trim();
  return title ? { seamFrom: title } : {};
}
export function gate2Cards(input: {
  order: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => Gate2NoteInput | undefined;
  /** The run and each card's revision: with it a chapter whose stored proof no longer fits its text is flagged `proofStale`. */
  proofContext?: { runId: string; revisionOf: (id: string) => number };
  /** What the last whole-book consistency check found for a chapter (`chapterInconsistencies`). Absent: not shown. */
  inconsistencies?: (id: string) => ChapterInconsistency[];
}): Gate2Card[] {
  return input.order.map((id, at): Gate2Card => {
    const note = input.noteOf(id);
    const view = bookCardView(note ?? {});
    const issue = typeof note?.pipelineIssue === "string" ? note.pipelineIssue : "";
    const checked = view.stage === "checked";
    const proof = checked || view.stage === "needs-review" ? latestStoredProof(note?.detail ?? "") : undefined;
    const structure = /^structure unmet: (\S+(?: \S+)*)$/.exec(issue.trim());
    const role = typeof note?.bookRole === "string" ? note.bookRole : undefined;
    const handEdited = view.stage === "needs-review" && /^write failed: hand_edited$/.test(issue.trim());
    // Only a `[!vam-book]` callout (or the program's fingerprint) shows the program wrote this text; anything else came before the book.
    const beforeBook = handEdited && !readBodyRecord(note?.detail ?? "")?.fp && !hasHiddenCallout(note?.detail ?? "");
    // "Keep my version" for this very text: the reader's answer stands, the proof's findings about it are not asked again.
    const kept = isKept(note?.detail ?? "");
    const stale =
      !kept &&
      !!input.proofContext &&
      proofIsStale(
        { prompt: note?.prompt ?? "", detail: note?.detail ?? "" },
        view.stage,
        id,
        input.proofContext.runId,
        input.proofContext.revisionOf(id)
      );
    const inconsistencies = (input.inconsistencies?.(id) ?? []).map(item => ({
      ...item,
      otherTitle: input.titleOf(item.other)
    }));
    const consistencyOnly =
      view.stage === "needs-review" && issue.trim() === "consistency" && inconsistencies.length > 0;
    return {
      id,
      index: at + 1,
      title: input.titleOf(id),
      stage: view.stage,
      ...(role ? { role } : {}),
      ...(view.stage === "needs-review" && issue ? { failureText: reasonOf(issue, proof) } : {}),
      structureUnmet:
        checked && structure && !kept ? structure[1].split(" ").filter(token => !token.startsWith("image_")).length : 0,
      factsOpen:
        checked && !kept
          ? (proof?.items ?? []).filter(item => item.type === "fact" && item.status !== "met").length
          : 0,
      galleryBare: checked && galleryBare(role, note),
      seam: view.seam,
      ...(view.seam ? seamFromOf(note?.pipelineSeam, input.order, at, input.titleOf) : {}),
      ...(handEdited ? { handEdited: true, bodyFp: integrityFp(note?.detail ?? "") } : {}),
      ...(beforeBook ? { handBeforeBook: true } : {}),
      ...(stale ? { proofStale: true } : {}),
      ...(inconsistencies.length ? { inconsistencies } : {}),
      ...(consistencyOnly ? { consistencyOnly: true } : {})
    };
  });
}

/** What the view remembers about card reruns (memory only; dies with the view). */
export class BookReviewMemory {
  /** Cards whose latest rerun gave the same result and still need a person. */
  readonly unchanged = new Set<string>();
}

/**
 * Runs one card's rerun and keeps the "same result, still needs a person" mark honest: the old mark goes before the run starts and
 * comes back only when this run left the result the same. The card's rerun button and its right-click menu both use it.
 */
export async function runTrackedRerun(
  memory: BookReviewMemory,
  nodeId: string,
  rerun: () => Promise<{ unchanged: boolean } | void>
): Promise<void> {
  memory.unchanged.delete(nodeId);
  const result = await rerun();
  if (result && result.unchanged) memory.unchanged.add(nodeId);
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
  /** The stored proof no longer fits the text. Part of the hash only when true, so every earlier fingerprint stays the same. */
  stale?: boolean;
  /** The consistency findings shown for the chapter. Part of the hash only when present, so every earlier fingerprint stays the same. */
  inconsistencies?: readonly ChapterInconsistency[];
}
export const attentionFingerprint = (input: AttentionFpInput): string =>
  hashText(
    JSON.stringify([
      input.stage,
      input.issue ?? "",
      input.proofKey ?? "",
      input.seam ?? "",
      ...(input.stale ? ["edited"] : []),
      ...(input.inconsistencies?.length
        ? [input.inconsistencies.map(item => [item.other, item.own, item.theirs, item.suggestion])]
        : [])
    ])
  );

/** A stable fingerprint of the newest stored proof of a Detail (what the proofreader found), or "" when there is none. */
export const proofFingerprint = (detail: string): string => {
  const proof = latestStoredProof(detail);
  return proof ? hashText(JSON.stringify(proof)) : "";
};

/** A chapter that needs a look, with its problems and the fingerprint a tick on its box must match. */
export interface ReviewEntry {
  card: Gate2Card;
  problems: ReviewProblem[];
  fp: string;
}
/** The chapters of the run that need a look, in reading order, from their notes; the one function the callouts, the cards and the bar all read. */
export function reviewEntries(input: {
  order: readonly string[];
  titleOf: (id: string) => string;
  noteOf: (id: string) => Gate2NoteInput | undefined;
  proofContext?: { runId: string; revisionOf: (id: string) => number };
  inconsistencies?: (id: string) => ChapterInconsistency[];
}): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  for (const card of gate2Cards(input)) {
    const problems = reviewProblems(card);
    if (!problems.length) continue;
    const note = input.noteOf(card.id);
    out.push({
      card,
      problems,
      fp: attentionFingerprint({
        stage: card.stage,
        issue: typeof note?.pipelineIssue === "string" ? note.pipelineIssue : "",
        proofKey: proofFingerprint(note?.detail ?? ""),
        seam: typeof note?.pipelineSeam === "string" ? note.pipelineSeam : "",
        stale: card.proofStale === true,
        inconsistencies: card.inconsistencies?.map(({ other, own, theirs, suggestion }) => ({
          other,
          own,
          theirs,
          suggestion
        }))
      })
    });
  }
  return out;
}

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
export const idPart = (value: string): string => value.replace(/[^\w.-]/g, "");

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
    `> ${t("ui.book_note_trial_edit")}`,
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
  runId: string,
  hand?: HandEditBox
): string {
  const next = linksLine([["ui.book_note_review_next_0", nextLink]]);
  return quoted([
    `> [!vam-review] ${t("ui.book_note_review_title")}`,
    ...reasons.slice(0, 5).map(reason => `> ・${plainText(reason)}`),
    // A hand-edited chapter has two separate answers: keep it (a resolution) or rewrite it (a one-time command bound to the text and to `op`).
    `> - [ ] ${t(hand ? "ui.book_note_review_keep" : "ui.book_note_review_accept")}`,
    // A queued rewrite keeps its tick when the box is written again (the queue lives in the box: the tick is what a later drain reads).
    `> - [${hand?.queued ? "x" : " "}] ${t(hand ? "ui.book_note_review_rewrite" : "ui.book_note_review_fixed")}`,
    ...(hand?.status ? [`> ${plainText(hand.status)}`] : []),
    ...(next ? [next] : []),
    `> %%vam-review:${idPart(runId)}:${idPart(card.id)}:${idPart(fp)}${handSuffix(hand)}%%`,
    VERSION_LINE
  ]);
}

/** What a hand-edited chapter's box carries besides the usual: the operation id, the text it was written for, a queued rewrite, a status line. */
export interface HandEditBox {
  op: string;
  ifp: string;
  queued?: boolean;
  /** One plain line under the two boxes ("queued", why the last rewrite did not happen); it starts with ⏳ or ⚠. */
  status?: string;
}
const handSuffix = (hand: HandEditBox | undefined): string =>
  hand ? `:${idPart(hand.op)}:${idPart(hand.ifp)}${hand.queued ? ":q" : ""}` : "";
const STATUS_LINE = /^[ \t]{0,3}>[ \t]?[⏳⚠]/u;

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

/** The text without the program's callouts that `drop` picks, each with the one blank line it brought. Nothing else changes. */
export function removeProgramCalloutsWhere(text: string, drop: (callout: ProgramCallout) => boolean): string {
  const lines = text.split("\n");
  const gone = new Set<number>();
  const picked = ownedIn(lines).filter(drop);
  if (!picked.length) return text;
  for (const c of picked) {
    for (let i = c.start; i < c.end; i++) gone.add(i);
    if (c.end < lines.length && !bare(lines[c.end]).trim()) gone.add(c.end);
  }
  return lines.filter((_, i) => !gone.has(i)).join("\n");
}
/** The text without the program's callouts of `kind` (all kinds when omitted). */
export const removeProgramCallouts = (text: string, kind?: "trial" | "review"): string =>
  removeProgramCalloutsWhere(text, c => !kind || c.kind === kind);

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

/**
 * The header of a review box (`[!vam-review]` with its fold sign) with `title`; the sign is `sign` (kept when undefined). The line
 * ending stays.
 */
const retitle = (line: string, title: string, sign?: "" | "-"): string => {
  const cr = line.endsWith("\r") ? "\r" : "";
  return (
    bare(line).replace(
      /(\[!vam-review\])([+-]?).*$/i,
      (_, head: string, was: string) => `${head}${sign ?? was} ${title}`
    ) + cr
  );
};
/** The words of the box the reader ticked as the answer (accept or keep; "I fixed it" only on a plain box); undefined when none is. */
function answerOf(lines: string[], box: ProgramCallout): string | undefined {
  const ticks: { on: boolean; label: string }[] = [];
  for (let i = box.start + 1; i < box.end; i++) {
    const m = CHECKBOX.exec(bare(lines[i]));
    if (m) ticks.push({ on: m[1] !== " ", label: bare(lines[i]).slice(m[0].length).trim() });
  }
  const answer = ticks[0]?.on ? ticks[0] : !box.op && ticks[1]?.on ? ticks[1] : undefined;
  return answer ? plainText(answer.label) : undefined;
}
/** The review boxes changed line by line: `edit` gets each box and the lines; it returns the new header or undefined (unchanged). */
function editReviewHeaders(text: string, edit: (box: ProgramCallout, lines: string[]) => string | undefined): string {
  const lines = text.split("\n");
  let changed = false;
  for (const c of ownedIn(lines)) {
    if (c.kind !== "review") continue;
    const next = edit(c, lines);
    if (next === undefined || next === lines[c.start]) continue;
    lines[c.start] = next;
    changed = true;
  }
  return changed ? lines.join("\n") : text;
}
/** The handled title of a ticked box ("Handled (you chose …)"); undefined when nothing that answers it is ticked. */
const handledTitle = (lines: string[], box: ProgramCallout): string | undefined => {
  const answer = answerOf(lines, box);
  return answer === undefined ? undefined : t("ui.book_note_review_handled_0", answer);
};

/**
 * The ticked review box says it is handled ("Handled (you chose …)") and stays open: what the reader sees the moment after the tick,
 * before it folds (mockup ⑦-3: it folds three seconds later). No ticked box: the text comes back unchanged.
 */
export function markReviewHandled(text: string): string {
  return editReviewHeaders(text, (box, lines) => {
    const title = handledTitle(lines, box);
    return title === undefined ? undefined : retitle(lines[box.start], title);
  });
}

/**
 * The review box folded (`[!vam-review]-`) under its handled title when it is ticked: the ticks and the marker stay. Already folded,
 * or no review box: the text comes back unchanged.
 */
export function collapseReviewCallouts(text: string): string {
  return editReviewHeaders(text, (box, lines) => {
    const title = handledTitle(lines, box);
    return title === undefined
      ? box.sign === "-"
        ? undefined
        : lines[box.start].replace(REVIEW_SIGN, "[!vam-review]-")
      : retitle(lines[box.start], title, "-");
  });
}

/** A review box no longer ticked opens again with its question as title (it was folded or titled "handled" when it was ticked). */
export function reopenReviewCallouts(text: string): string {
  return editReviewHeaders(text, (box, lines) =>
    answerOf(lines, box) === undefined ? retitle(lines[box.start], t("ui.book_note_review_title"), "") : undefined
  );
}

export interface ReviewState {
  runId: string;
  nodeId: string;
  fp: string;
  accept: boolean;
  fixed: boolean;
  collapsed: boolean;
  /** Its title is no longer the question (it was titled "handled" when it was ticked). */
  handled: boolean;
  /** A hand-edited chapter's box: its operation id, the integrity fingerprint of the text it was written for, and a queued rewrite. */
  op?: string;
  ifp?: string;
  queued?: boolean;
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
    collapsed: box.sign === "-",
    handled: !bare(lines[box.start]).endsWith(` ${t("ui.book_note_review_title")}`),
    ...(box.op ? { op: box.op, ifp: box.ifp ?? "", ...(box.queued ? { queued: true } : {}) } : {})
  };
}

/** Handled: one of the two boxes is ticked and the box was written for the chapter's attention as it is now (a changed fingerprint voids the tick). */
export const isReviewResolved = (state: ReviewState | undefined, fp: string): boolean =>
  !!state && (state.op ? state.accept : state.accept || state.fixed) && state.fp === fp;

/** A hand-edited chapter's box with the reader's "rewrite" ticked and not yet carried out (the one-time command). */
export const isRewriteAsked = (state: ReviewState | undefined): boolean => !!state?.op && state.fixed;

/**
 * A hand-edited chapter's box changed in place: the rewrite tick cleared, the operation id, the text it is bound to, the queue mark and the
 * status line set as `patch` says. Any other box, or a text without one, comes back unchanged.
 */
export function patchHandBox(
  text: string,
  patch: { op?: string; ifp?: string; queued?: boolean; status?: string | null; clearRewrite?: boolean }
): string {
  const lines = text.split("\n");
  const box = ownedIn(lines).find(c => c.kind === "review" && c.op);
  if (!box) return text;
  const cr = lines[box.start].endsWith("\r") ? "\r" : "";
  const out: string[] = [];
  let ticks = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < box.start || i >= box.end) {
      out.push(line);
      continue;
    }
    if (STATUS_LINE.test(bare(line))) continue;
    if (CHECKBOX.test(bare(line))) {
      ticks++;
      out.push(ticks === 2 && patch.clearRewrite ? line.replace(/\[[xX]\]/, "[ ]") : line);
      if (ticks === 2 && patch.status) out.push(`> ${plainText(patch.status)}${cr}`);
      continue;
    }
    if (i > box.start && OWNER_MARKER_LINE.test(bare(line))) {
      const op = patch.op ?? box.op ?? "";
      const ifp = patch.ifp ?? box.ifp ?? "";
      const queued = patch.queued ?? box.queued ?? false;
      out.push(
        `> %%vam-review:${idPart(box.runId)}:${idPart(box.nodeId)}:${idPart(box.fp ?? "")}:${idPart(op)}:${idPart(ifp)}${queued ? ":q" : ""}%%${cr}`
      );
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
const OWNER_MARKER_LINE = /^[ \t]{0,3}>[ \t]?%%vam-review:/;

/**
 * A checked or needs-review card whose chapter text changed after its proofread: a proof was stored, but none (finished or failed) fits
 * the key of the text as it is now. Notes never change the key (the proof body drops their wrappers); applying them does.
 */
export function proofIsStale(
  card: { prompt: string; detail: string },
  stage: PipelineStage | "pending",
  nodeId: string,
  runId: string,
  revision: number
): boolean {
  if (stage !== "checked" && stage !== "needs-review") return false;
  if (!latestStoredProof(card.detail)) return false;
  const key = proofKey({
    runId,
    nodeId,
    revision,
    body: projectProofBody(stripImageLines(chapterBody(card.detail))),
    checklist: parseChecklist(card.prompt)
  });
  return !findStoredProof(card.detail, key) && !findStoredProof(card.detail, failedProofKey(key));
}
