import { t, type TranslationKey } from "../../i18n";
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
import { bookCardView, bookIssueText, lengthText, pictureSentences } from "./book-pipeline-ui";
import { joinReasons, splitCarriedIssue } from "./book-pipeline-reasons";
import { bodyImageUrls } from "./book-pipeline-run";

import { projectProofBody } from "../../core/book-pipeline/book-notes";
import { integrityFp, isKept, keepVoided, readBodyRecord } from "../../core/book-pipeline/body-integrity";
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
  /** The same reasons one by one (every unmet proof item, length, pictures): what the reader-visible boxes list. */
  failureLines?: string[];
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
            if (item.kind === "direction")
              return t("ui.book_reason_direction_0_1_2_3", item.own, item.theirs, item.otherTitle, item.suggestion);
            if (item.reference)
              return t("ui.book_reason_chapter_ref_0_1_2_3", item.own, item.theirs, item.otherTitle, item.suggestion);
            // A quote is the chapter's own sentence; a claim no sentence matched is the model's paraphrase, shown as such.
            const own = t(item.ownLoose ? "ui.book_paraphrase_0" : "ui.book_quote_0", item.own);
            const theirs = t(item.theirsLoose ? "ui.book_paraphrase_0" : "ui.book_quote_0", item.theirs);
            const sentence =
              item.other === card.id
                ? t("ui.book_reason_inconsistent_self_0_1", own, theirs)
                : t("ui.book_reason_inconsistent_0_1_2", item.otherTitle, own, theirs);
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

export { joinReasons };

/**
 * The reasons of a needs-review card as separate pieces (length, pictures, each proof item not met by its own note, a carried failure);
 * `all` lists every open proof item, else at most 3 distinct notes (what the one-line reason uses).
 */
function reasonParts(issue: string, proof: StoredProofView | undefined, all: boolean): string[] {
  const carried = splitCarriedIssue(issue);
  if (carried) return [bookIssueText(carried.failure), ...reasonParts(carried.carried, proof, all)];
  const pictures = splitPictureIssue(issue);
  const sentences = pictureSentences(pictures);
  if (sentences.length) return pictures.rest ? [...reasonParts(pictures.rest, proof, all), ...sentences] : sentences;
  const { rest, length } = splitLengthIssue(issue);
  if (length) {
    const sentence = lengthText(length);
    return rest ? [...reasonParts(rest, proof, all), sentence] : [sentence];
  }
  if (!/^proof unmet/.test(issue.trim())) return [bookIssueText(issue)];
  if (/facts_unverified/.test(issue)) return [t("ui.book_reason_all_facts_unverified")];
  const open = (proof?.items ?? []).filter(item => item.status !== "met");
  const notes = [...new Set(open.map(item => plainNote(unescapeMarkdownText(item.note))).filter(Boolean))];
  if (notes.length) return all ? notes : notes.slice(0, 3);
  return [open.length ? t("ui.book_panel_reason_unchecked_0", open.length) : t("ui.book_panel_reason_unmet_plain")];
}

/** The reason of a needs-review card in words: the proof's own notes of the items not met, else the count, else a plain sentence; never a code. */
export const reasonOf = (issue: string, proof: StoredProofView | undefined): string =>
  joinReasons(reasonParts(issue, proof, false));
/** The same reasons, one line each and none left out: what the reader-visible boxes list. */
export const reasonLinesOf = (issue: string, proof: StoredProofView | undefined): string[] =>
  reasonParts(issue, proof, true);

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
    // "Keep my version" for this very text: the reader's answer stands, the proof's findings about it are not asked again.
    const kept = isKept(note?.detail ?? "");
    const record = readBodyRecord(note?.detail ?? "");
    // A kept text edited since: the keep no longer holds, the chapter asks the hand-edit question again (whatever its stage says now).
    const keptVoided = keepVoided(note?.detail ?? "");
    const handEdited =
      keptVoided || (view.stage === "needs-review" && /^write failed: hand_edited$/.test(issue.trim()));
    // Only a `[!vam-book]` callout (or the program's fingerprint) shows the program wrote this text; anything else came before the book.
    const beforeBook = handEdited && !record?.fp && !hasHiddenCallout(note?.detail ?? "");
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
    const inconsistencies = (kept ? [] : (input.inconsistencies?.(id) ?? [])).map(item => ({
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
      ...(view.stage === "needs-review" && issue
        ? { failureText: reasonOf(issue, proof), failureLines: reasonLinesOf(issue, proof) }
        : {}),
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
/** Every reason of an entry as one line each, for the callout boxes: the failure sentence is split into its pieces, none dropped. */
export const entryReasons = (entry: ReviewEntry): string[] =>
  entry.problems.flatMap(problem =>
    problem.kind === "failed" && entry.card.failureLines?.length ? entry.card.failureLines : [problem.text]
  );
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

export const idPart = (value: string): string => value.replace(/[^\w.-]/g, "");

// ---- the callouts ----

const VERSION_LINE = "> %%vam-callout-version:1%%";
const quoted = (lines: string[]): string => lines.join("\n");
/** What one chapter's AI proofread box tells: how many items were checked, each place that was fixed, each that was not (with its reason code). */
/** A fixed place: what was wrong and the sentence written; `suggestion` is the model's advice and is never shown. */
export interface AiBoxFix {
  problem?: string;
  replacement?: string;
  suggestion?: string;
}
export interface AiBoxInput {
  checked: number;
  /** The count the title shows (the tool bar's number); absent: the length of `fixes`. */
  fixed?: number;
  fixes: readonly AiBoxFix[];
  /** Places the whole-book proofread changed in this chapter (already counted in the bar's total, so not in `fixed`). */
  bookFixes?: readonly AiBoxFix[];
  open: readonly { problem: string; reason: string }[];
  /** The proofread did not finish: the box says so instead of counting. */
  incomplete?: boolean;
}
/** The reason codes of an open item that have a sentence of their own (`ui.book_ai_reason_<code>`); any other code reads as the general one. */
const AI_REASON_KEY: Record<string, TranslationKey> = {
  still_present: "ui.book_ai_reason_still_present",
  sources_conflict: "ui.book_ai_reason_sources_conflict",
  source_unreachable: "ui.book_ai_reason_source_unreachable",
  unfixable: "ui.book_ai_reason_unfixable",
  fix_refused_picture: "ui.book_ai_reason_fix_refused_picture",
  fix_refused_length: "ui.book_ai_reason_fix_refused_length",
  fix_quote_missing: "ui.book_ai_reason_fix_quote_missing",
  fix_forbidden_syntax: "ui.book_ai_reason_fix_forbidden_syntax",
  hand_edited: "ui.book_ai_reason_hand_edited",
  fix_failed: "ui.book_ai_reason_fix_failed",
  proof_incomplete: "ui.book_ai_reason_proof_incomplete",
  not_fixed: "ui.book_ai_reason_not_fixed",
  not_fixed_in_time: "ui.book_ai_reason_not_fixed_in_time"
};
/** A reason code in words (an unknown code reads as the general sentence; the code itself is never shown). */
export const aiReasonText = (reason: string): string =>
  t(Object.prototype.hasOwnProperty.call(AI_REASON_KEY, reason) ? AI_REASON_KEY[reason] : "ui.book_ai_reason_other");

const FIX_SHOWN_CHARS = 60;
/** One fix as a line: what was wrong and the sentence now in the text (never the model's suggestion, which may not be what was written). */
const fixLine = (fix: AiBoxFix): string => {
  const problem = plainText(fix.problem);
  const raw = typeof fix.replacement === "string" ? fix.replacement : "";
  const cut = Array.from(raw.replace(/\s+/g, " ").trim());
  const written = cut.length
    ? plainText(cut.slice(0, FIX_SHOWN_CHARS).join("")) + (cut.length > FIX_SHOWN_CHARS ? "…" : "")
    : "";
  if (!written) return `> ・${t("ui.book_ai_box_fixed_0", problem)}`;
  return `> ・${problem ? t("ui.book_ai_box_fixed_0_1", problem, written) : t("ui.book_ai_box_fixed_replaced_0", written)}`;
};

/**
 * The box at the top of a chapter the AI proofread: one title with the counts, one plain sentence per fix, one per problem it could not
 * fix (why, and that the book's last page lists it). Nothing in it asks the reader to do anything: no tick box, no button. Every word a
 * model wrote goes through {@link plainText}. It is a `vam-review` callout (the program's own kind), so it is found, replaced and
 * taken off by the same code as before; its marker carries a fingerprint of its text, so an unchanged box is not written again.
 */
export function aiProofCallout(input: AiBoxInput, runId: string, nodeId: string): string {
  const title = input.incomplete
    ? t("ui.book_ai_box_title_incomplete")
    : t("ui.book_ai_box_title_0_1_2", input.checked, input.fixed ?? input.fixes.length, input.open.length);
  const lines = [
    ...input.fixes.map(fixLine),
    ...(input.bookFixes?.length
      ? [`> ・${t("ui.book_ai_box_book_fixed_0", input.bookFixes.length)}`, ...input.bookFixes.map(fixLine)]
      : []),
    ...input.open.map(item => {
      const why = aiReasonText(item.reason);
      const problem = plainText(item.problem);
      return `> ・${t("ui.book_ai_box_open_0", problem ? `${problem}${t("ui.book_ai_box_sep")}${why}` : why)}`;
    })
  ];
  const fp = hashText([title, ...lines].join("\n"));
  return quoted([
    `> [!vam-review] ${title}`,
    ...lines,
    `> %%vam-review:${idPart(runId)}:${idPart(nodeId)}:${idPart(fp)}%%`,
    VERSION_LINE
  ]);
}
/** The fingerprint an {@link aiProofCallout} carries (what the aligner compares to know a box is already as wanted). */
export const aiProofFingerprint = (input: AiBoxInput): string => {
  const marker = /%%vam-review:[^:]*:[^:]*:([\w.-]+)%%/.exec(aiProofCallout(input, "r", "n"));
  return marker?.[1] ?? "";
};

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
 * `callout` (an {@link aiProofCallout} text) at the top of the Detail block, replacing the program's callouts of the
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
  const body = projectProofBody(stripImageLines(chapterBody(card.detail)));
  const checklist = parseChecklist(card.prompt);
  // A stored proof of this run for this very text stays valid at a later revision: a redo that wrote nothing (live v5, a refused
  // fix) bumps the revision but leaves the text, so the chapter is not "changed, not proofread again".
  for (let at = revision; at >= Math.max(0, revision - STALE_REVISIONS); at--) {
    const key = proofKey({ runId, nodeId, revision: at, body, checklist });
    if (findStoredProof(card.detail, key) || findStoredProof(card.detail, failedProofKey(key))) return false;
  }
  return true;
}
/** How many earlier revisions {@link proofIsStale} looks back for a proof of the same text. */
const STALE_REVISIONS = 20;
