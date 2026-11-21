/**
 * Picture-book pipeline runner. Executes what `core/book-pipeline/machine.ts` allows and nothing else: every gate (retries,
 * needs-review, budget pause, stale results) lives in the machine; this file moves data between it, the model ports and the
 * notes. Everything it touches is an injected port, so it is tested with fakes (no main.ts, no view).
 *
 * Rules kept here: the state is saved through one `PipelineStore` (one commit queue; the budget gate shares it) before a step's
 * call; a step's note write is a guarded commit (the file must still be the text the step started from, and the run must still
 * be current, checked inside the write itself); a card's frontmatter is only written before and after a step, never while its
 * author runs; Stop aborts every call (a provider that ignores abort cannot hang it); after dispose nothing is written, not even
 * the map file. Only ids, counts and codes are logged.
 */
import type { AdmissionContext } from "../../core/admission";
import { carryIssue } from "./book-pipeline-reasons";
import type { FindImagesRequest, FoundImages } from "../../core/steps/book-pipeline/find-images";
import type { AiBookProofRequest, AiProofRequest, AiProofRun } from "../../core/steps/book-pipeline/ai-proof";
import type { AiFixRequest } from "../../core/steps/book-pipeline/ai-fix";
import {
  aiProofBody,
  aiProofKey,
  chapterSources,
  checkState,
  fixTargetsOf,
  priorOf,
  type AiProofReview
} from "../../core/book-pipeline/ai-proof";
import { applyAiEdits, refusedReasons, type AiFixRefusal, type RawAiEdit } from "../../core/book-pipeline/ai-fix";
import { chapterReferenceFindings, type ReferenceChapter } from "../../core/book-pipeline/chapter-references";
import { bookStructure, type BookStructure } from "../../core/book-pipeline/structure";
import { compactChapters, removedChapterRefs } from "../../core/book-pipeline/consistency";
import { directionFindings, numericFindings } from "../../core/book-pipeline/cross-checks";
import { isBudgetExhausted } from "../../core/admission";
import { createBudgetAdmission, createStoreBudgetPort } from "../../core/book-pipeline/budget";
import { imageKey } from "../../core/book-pipeline/image-dedupe";
import { formatPipelineLog } from "../../core/book-pipeline/log";
import {
  searchCommons,
  type CommonsFetch,
  type CommonsQueue,
  type CommonsRejection,
  type CommonsRunBudget
} from "../../core/book-pipeline/commons-search";
import { askWords, wordHits } from "../../core/book-pipeline/file-fit";
import { composeOpenIssuesNote, type BookOpenIssue } from "../../core/book-pipeline/open-issues";
import {
  PipelineStore,
  addBudget,
  acceptMapChange,
  advancePhase,
  applyBudgetExhausted,
  applyCancelled,
  abandonAi,
  aiChapterDue,
  applyAiFailure,
  applyAiFix,
  applyAiProof,
  applyAiStopped,
  beginAiStep,
  isAiCurrent,
  BOOK_PROOF_BUSY,
  applyFailure,
  applyReset,
  applySuccess,
  autoFixesOf,
  useExpandPass,
  beginStep,
  cardRevision,
  confirmGate1,
  finishRun,
  isCurrent,
  newBookPipeline,
  nextActions,
  pauseForMap,
  recoverInterrupted,
  requestAutoFix,
  resetCard,
  resumeRun,
  retryGlobalPlan,
  retryTrial,
  startTrial,
  backToPlan,
  stopRun,
  failRun,
  type PipelineAction,
  type PipelineStepKind,
  type StepToken
} from "../../core/book-pipeline/machine";
import {
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  effectiveOrder,
  BOOK_EXPAND_PASSES,
  mapDifference,
  readBookPipeline,
  reserveBudget,
  type BookPipelineData,
  type BookRole,
  type BookSettings,
  type PipelineFields,
  type PipelineFieldsPatch,
  type PipelinePhase,
  type PipelineStage,
  type PipelineStep
} from "../../core/book-pipeline/model";
import {
  applyNotesStep,
  MAX_NOTE_PARAGRAPHS,
  type ApplyNotesRequest
} from "../../core/steps/book-pipeline/apply-notes";
import { applyReplies, snapshotNotes, type AppliedEdit, type ApplyOutcome } from "../../core/book-pipeline/notes-apply";
import { findNotes, projectProofBody } from "../../core/book-pipeline/book-notes";
import {
  appendResearchNote,
  carryWorkLog,
  neutralizeDetail,
  quoteAll,
  hidePipelineLog,
  findStoredProof,
  findStoredProofModels,
  extractProofRecords,
  addPictureSources,
  carryImageSection,
  dropPlaceholderSections,
  replaceBookPlanSection,
  replaceBookStructure,
  fencedLines,
  normalizeWorkRecords,
  workLogLines,
  replaceProofSection,
  replaceResearchRecord,
  chapterBody,
  readerCallouts,
  detailBlockOf,
  dropProcessNotes,
  emptyExpandStats,
  expandChapterDetail,
  replaceDetailBlock,
  neutralizeText
} from "../../core/book-pipeline/note-sections";
import {
  composeBookPlan,
  composeBookStructure,
  parseCardPoints,
  type StructureEntry,
  composeCardPrompt,
  parseBookPlanBody,
  parseBookPlanDecisions,
  parseCardPrompt,
  parseChecklist,
  parseImageSlots,
  dropEntryLine,
  dropParentLine,
  dropEntryNaming,
  neighbourLineTitle,
  retargetNeighbourLine,
  rewriteNeighbourLine,
  type NeighbourCard
} from "../../core/book-pipeline/plan-text";
import {
  composeProofRecord,
  relabelProofRecord,
  composeProofSection,
  failedProofKey,
  isProofFailure,
  proofKey,
  proofSectionHeading,
  safeHref as safeLinkHref,
  type ProofCounts,
  proofVerdict,
  type ProofResult
} from "../../core/book-pipeline/proof";
import {
  bookExpandRequirements,
  BOOK_EXPAND_RETRY_INSTRUCTION,
  fixInstructionText,
  effectiveSettings,
  imageCountRange,
  lengthNeeded,
  lengthReason,
  lengthBody,
  lengthRange,
  lengthToken,
  type LengthIgnored,
  type LengthReason
} from "../../core/book-pipeline/settings";
import { escapeMarkdownText, unescapeMarkdownText } from "../../core/book-pipeline/text";
import type { ReasoningLevel } from "../../ai/types";
import type { ContentLanguage } from "../../i18n";
import type { MapDocument } from "../../map-model";
import { isPlaceholder } from "../../core/note-placeholder";
import type { NotePatch } from "../../repository";
import { isBookStepError, type BookStepBase } from "../../core/steps/book-pipeline/base";
import {
  checkImageText,
  choosePictures,
  composeImageTextLine,
  composeSlotsRecord,
  imageIssueTokens,
  latestSlotsRecord,
  pictureShortfallToken,
  captionLatinIssue,
  pictureMismatchToken,
  PICTURE_LIMITED_TOKEN,
  stripImageLines,
  fillSlotMarkers,
  residualMarkerLines,
  scanSlotMarkers,
  verifyFill,
  MAX_IMAGE_SLOTS,
  type FillResult,
  type ImageSlot,
  type ProbedCandidate,
  type SlotOutcome
} from "../../core/book-pipeline/image-slots";
import {
  cardPlanFits,
  cardPlanStep,
  placeText,
  type CardNeighbour,
  type CardPlanPlace,
  type CardPlanRequest,
  type CardPlanResult
} from "../../core/steps/book-pipeline/card-plan";
import {
  globalPlanStep,
  type GlobalPlanRequest,
  type GlobalPlanResult
} from "../../core/steps/book-pipeline/global-plan";
import type { ProofreadRequest, ProofreadRun } from "../../core/steps/book-pipeline/proofread";
import { BOOK_CHECKS, researchVoiceSentences } from "../../core/book-pipeline/prose-checks";
import type { StepDefinition } from "../../core/step-runner";
import { untilAborted } from "./argument-run";
import {
  avoidSourcesInstruction,
  cardResultSnapshot,
  proofFixInstruction,
  sameReviewResult,
  type CardResultSnapshot
} from "./book-pipeline-rerun";
import { bookReadingOrder } from "./presentation-order";
import {
  bodyStateRaw,
  integrityFpRaw,
  isKept,
  isKeptRaw,
  isUntouched,
  pipelineWroteRaw,
  programStamp,
  programStampRaw,
  stampRaw
} from "../../core/book-pipeline/body-integrity";

const appliedIdsOf = (outcomes: readonly { id: string; applied: boolean }[]): string[] =>
  outcomes.filter(outcome => outcome.applied).map(outcome => outcome.id);
/** At most this many cards are in a step at once (the whole-book plan runs alone before them). */
export const BOOK_POOL = 5;

export type BookRunRefusal =
  | "busy"
  | "blocked"
  | "root"
  | "exists"
  | "unusable"
  | "missing"
  | "finished"
  | "budget"
  | "disposed"
  | "unreadable"
  | "not_gate1"
  | "not_gate"
  | "empty"
  | "not_stopped"
  | "instruction"
  /** Applying notes: a notes job already holds this map; a drive does; the job was cancelled; the map or card changed meanwhile; the backup failed; no note to apply. */
  | "notes_busy"
  | "drive_running"
  | "cancelled"
  | "stale"
  | "backup_failed"
  | "nothing"
  /** A rewrite the reader allowed was for a text that has changed since: nothing is rewritten. */
  | "text_changed";
/** The ids a needs-review proof names: its unmet fact points, else its unmet structure points, else the empty text. */
function unmetIds(items: readonly { id: string; type: string; status: string }[]): string {
  const unmet = items.filter(item => item.status === "unmet");
  const pick = unmet.filter(item => item.type === "fact");
  return (pick.length ? pick : unmet).map(item => code(item.id)).join(" ") || "no_body";
}

/** A card's summary as a neighbour description: the "no conclusion yet" placeholder says nothing, so it is blank. */
const summaryText = (summary: string): string => (isPlaceholder(summary.trim()) ? "" : summary);

export class BookPipelineRunError extends Error {
  constructor(readonly code: BookRunRefusal) {
    super(`book pipeline refused: ${code}`);
    this.name = "BookPipelineRunError";
  }
}

/** One card as the runner reads it: the parsed note, its pipeline fields and the whole file text (the guard's expected text). */
export interface PipelineCard {
  path: string;
  title: string;
  summary: string;
  prompt: string;
  detail: string;
  raw: string;
  fields: PipelineFields;
  /** The six `book-*` values the note holds (the root's are the owner's current values). */
  settings: BookSettings;
}
export interface BookRunConfig {
  planModel: string;
  authorModel: string;
  /** The picture search (and the start card's suggestions) run on this model. */
  imageModel: string;
  proofModel: string;
  reasoning: ReasoningLevel;
  language: ContentLanguage;
}
export interface AuthorInput {
  /** The map the run belongs to (the plugin finds the open view by it). */
  mapPath: string;
  nodeId: string;
  path: string;
  /** The effective whole-book settings; the port turns them into the research requirements. */
  settings: BookSettings;
  /** The card's planned picture slots (from its `## Prompt`); empty when the plan has none or the Prompt has no image plan: the author then leaves no marker. */
  slots: readonly ImageSlot[];
  /** The whole book's chapters with each brief's covers line (`current` marks this one); absent for an expansion. */
  chapters?: readonly { title: string; covers: string; current?: boolean }[];
  language: ContentLanguage;
  model: string;
  reasoning: ReasoningLevel;
  signal: AbortSignal;
  /** The call budget gate: the author's own `AiCalls` must carry it. */
  admission: AdmissionContext;
  /** The program's one-line request to use other sources (a source swap); absent for a normal write. Never carries untrusted text. */
  instruction?: string;
  /** The whole requirements instead of the ones built from `settings`, `slots` and `instruction` (the expansion of a too-short chapter). */
  requirements?: string;
  /** The write keeps the card's Summary (an expansion's answer only describes what it added). */
  keepSummary?: boolean;
  /** An in-place fix or expansion of a chapter that has its text: a call with no web search is not failed, and a failed call leaves the card's status as it was. */
  inPlace?: boolean;
  /** Checked synchronously inside the write: false (a stop, a replaced run, a removed card) means nothing is written. */
  authorize: (current?: string) => boolean;
  /** Runs inside the author's write on the text about to be saved: the cleaned text, or null (nothing is written). Pass it to the guarded write. */
  finalize: (content: string) => string | null;
}
export type AuthorOutcome =
  | { outcome: "written" }
  | { outcome: "budget-exhausted" }
  | { outcome: "failed"; reason: string }
  | { outcome: "cancelled" }
  | { outcome: "discarded" };
export type GuardOptions = {
  expectedContent?: string;
  authorize?: (current?: string) => boolean;
  /** Runs inside the same write on the text the patch produced; null refuses the write. */
  finalize?: (content: string) => string | null;
};

/** Everything the runner touches. `mutate` is the plugin's serialized write queue; the others are repository/model/network seams. */
export interface BookPipelinePorts {
  mutate(work: () => Promise<void>): Promise<void>;
  readMap(path: string): Promise<MapDocument>;
  updateMap(path: string, change: (map: MapDocument) => void): Promise<MapDocument>;
  readCard(path: string): Promise<PipelineCard>;
  writePipelineFields(path: string, patch: PipelineFieldsPatch): Promise<void>;
  /**
   * Writes `book-role` and `pipeline-role` together inside one file transaction, only while the role is still the pipeline's
   * (a `book-role` differing from a present `pipeline-role` was changed by hand). Returns whether it wrote. Absent: a read-then-write fallback.
   */
  writePipelineRole?(path: string, role: BookRole): Promise<boolean>;
  updateNoteGuarded(path: string, patch: NotePatch, options: GuardOptions): Promise<"written" | "discarded">;
  updateNoteRawGuarded(
    path: string,
    transform: (content: string) => string,
    options: GuardOptions
  ): Promise<"written" | "discarded">;
  /** Production: `runPlanStep(aiCalls, step, request, run)`. */
  runPlan<Request extends BookStepBase, Output>(
    step: StepDefinition<Request, Output>,
    request: Request,
    run: { signal: AbortSignal; admission?: AdmissionContext }
  ): Promise<Output>;
  /** Production: `runProofread(aiCalls, request, run)`. */
  runProofread(request: ProofreadRequest, run: ProofreadRun): Promise<ProofResult>;
  /**
   * The book's closing page ("still open") in `folder`: creates it, or rewrites an earlier one of ours; a same-named note that is not ours
   * is never touched (another name is used). Absent: no page is written and the book is done without it.
   */
  writeOpenIssues?(
    folder: string,
    language: ContentLanguage,
    content: string
  ): Promise<{ ok: true; path: string } | { ok: false }>;
  /**
   * Production: `runAiProof(aiCalls, request, run)`: the independent proofread of one chapter (a different model from the author's).
   * The AI proofread runs only when `aiProof`, `aiFix` and `aiBookProof` are all given.
   */
  aiProof?(request: AiProofRequest, run: AiProofRun): Promise<AiProofReview>;
  /** Production: `runAiFix(aiCalls, request, run)`: the author model's edits for the problems the proofread found. */
  aiFix?(request: AiFixRequest, run: { signal: AbortSignal; admission?: AdmissionContext }): Promise<RawAiEdit[]>;
  /** The whole-book proofread (its request and runner come with the book step). */
  aiBookProof?(request: AiBookProofRequest, run: AiProofRun): Promise<AiProofReview>;
  /** A drive of the map has ended (any way); queued work waits for this. Optional: fire and forget. */
  settled?(mapPath: string): void;
  /** The author step: the card's single-card research (charts off, fresh write-back). Never writes the card's frontmatter. */
  author(input: AuthorInput): Promise<AuthorOutcome>;
  probeImage(url: string, signal: AbortSignal): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Production: `runFindImages(aiCalls, request, run)`: one web search for the picture slots of a chapter. Absent: no picture search (every marked slot ends as not found). */
  findImages?(
    request: FindImagesRequest,
    run: { signal: AbortSignal; admission?: AdmissionContext }
  ): Promise<FoundImages>;
  /** Production: a GET of a Wikimedia Commons API address through `requestUrl` (any other address is refused). Absent: no program search after the finder. */
  fetchCommons?: CommonsFetch;
  /** The queue every Commons request waits in. Absent: the shared production queue (1 s between requests); tests pass one without real waits. */
  commonsQueue?: CommonsQueue;
  backupNote(path: string, raw: string): Promise<{ ok: true; path: string } | { ok: false }>;
  /**
   * Applying the reader's notes (absent: refused as unreadable). `readText` is the note as the writer will see it (an open editor's text
   * first, else the file); `write` is the notes writer (`createNoteWriter`): the transform may run twice and must be pure.
   */
  notes?: {
    readText(path: string): Promise<string>;
    write(path: string, transform: (text: string) => string): Promise<"written" | "unchanged" | "refused">;
  };
  /** True while a conversation chain, a multi-select research or an argument run holds this map. */
  blocked(mapPath: string): boolean;
  config(mapPath: string): BookRunConfig;
  /** A stored model id as the owner reads it (the plugin's display name); absent: the id itself. */
  modelLabel?(model: string): string;
  now(): string;
  newId(): string;
  log(line: string): void;
  /** Called when the sub-step changes without a saved state change (the card is now finding pictures), so the screen can repaint. */
  progressed?(mapPath: string): void;
  /** The program's callouts in the chapter notes (trial hint, review box). Absent: the notes are not touched. */
  callouts?: BookCalloutPort;
}
/** What the runner asks of the callouts in the notes: align them with the run now (never throws), or take them all off before the run is replaced. */
export interface BookCalloutPort {
  reconcile(mapPath: string): void | Promise<void>;
  /** True when every chapter note is clean; a false is logged by the port and does not stop the caller. */
  clear(mapPath: string): Promise<boolean>;
  /** Takes the program callouts off notes that are no longer on the map (a removed chapter), by path. */
  clearNotes?(mapPath: string, runId: string, cards: readonly { id: string; path: string }[]): Promise<boolean>;
}

export interface BookPipelineProgress {
  runId: string;
  phase: BookPipelineData["phase"];
  status: BookPipelineData["status"];
  pauseReason?: "budget" | "failed" | "map";
  /** With pauseReason "map": how many chapters the map gained and lost (counts only). */
  mapChange?: { added: number; missing: number };
  failureCode?: string;
  /** True while a drive is executing steps. */
  active: boolean;
  total: number;
  /** Exact counts by stage; `pending` has none yet. */
  counts: Record<PipelineStage | "pending", number>;
  budget: { used: number; limit: number };
  startedAt: string;
  phaseStartedAt: string;
  /** Cards a step (or a single-card rerun) is working on right now. */
  busyCards: string[];
  /** About how many seconds the planning/writing phase has left; only while a drive runs and at least {@link ETA_MIN_CARDS} cards of this phase finished. */
  etaSeconds?: number;
  /**
   * Memory only (never saved to the map file): the sub-step each busy card is in right now (`global` is the whole-book plan), with
   * when it began (ms). Finding pictures is part of the write step, so it only shows here.
   */
  current?: { nodeId: string; step: BookSubStep; startedAt: number }[];
  /** Memory only: how many cards finished each of the steps the bar lists. */
  steps?: BookStepCounts;
  /** Memory only: the single-card rerun running now and when it began (ms); gone when it ends, whatever way it ended. */
  rerun?: { nodeId: string; startedAt: number };
}
/** What a single-card rerun tells its caller: a card that needed a person before and still does with the same result. */
export interface BookRerunResult {
  unchanged: boolean;
}
export type BookSubStep = "plan" | "write" | "images" | "proof";
export type BookStepCounts = Record<BookSubStep, number>;
/**
 * The cards done per step from the stage counts: planned or beyond has its plan, written or checked has its text (and pictures:
 * they are found inside the write step), checked has its proofread. `imagesDone` adds cards whose pictures are in but whose write has not ended.
 */
export function stepCounts(
  counts: BookPipelineProgress["counts"],
  imagesDone = 0,
  review: { settled?: boolean; proofFailed?: number } = {}
): BookStepCounts {
  const written = counts.written + counts.checked;
  // From gate 2 on, a needs-review card is a finished card the owner must look at: every step counts. While writing, a card whose
  // proofread was the failing step has its text and pictures; any other needs-review card only has what came before the failure.
  const reviewed = counts["needs-review"];
  const textual = written + (review.settled ? reviewed : (review.proofFailed ?? 0));
  return {
    plan: counts.planned + written + reviewed,
    write: textual,
    images: textual + imagesDone,
    proof: counts.checked + (review.settled ? reviewed : 0)
  };
}
/** At least this many finished cards before the estimate is shown. */
export const ETA_MIN_CARDS = 5;
type StepResult = "ok" | "failed" | "cancelled" | "budget" | "dropped" | "none";

type Outcome =
  | { kind: "ok"; after?: () => Promise<void> }
  | { kind: "failed"; reason: string; forceReview?: boolean }
  | { kind: "cancelled" }
  | { kind: "budget" };

interface CardInfo {
  path: string;
  title: string;
  summary: string;
  role: BookRole;
}
interface Drive {
  mapPath: string;
  /** `phase:status` as last written; a change of it asks the notes to follow. */
  syncKey?: string;
  controller: AbortController;
  store: PipelineStore;
  admission: AdmissionContext;
  config: BookRunConfig;
  rootId: string;
  cards: Map<string, CardInfo>;
  /** The map's card ids as the last map-modify event saw them; undefined until the first event (then the card is taken as present). A write checks it synchronously. */
  members?: Set<string>;
  /** Each card's parent on the map (as loaded): a chapter's child cards are the cards of the order whose parent it is. */
  parents: Map<string, string | null>;
  /** Cards that already had a `book-role` when loaded (the owner's choice; the global plan does not overwrite it), and the missing ones with their default. */
  ownerRoles: Set<string>;
  missingRoles: Map<string, BookRole>;
  stages: Map<string, PipelineStage | undefined>;
  backedUp: Set<string>;
  backupPaths: Map<string, string>;
  reasons: Map<string, string>;
  /** The issue a chapter had when its automatic fix began (its field is cleared meanwhile): a failed fix carries it (W). */
  fixIssues: Map<string, string>;
  busy: Set<string>;
  stopRequested: boolean;
  disposed: boolean;
  /** Set by a single-card rerun: runs instead of the loop, and a stop or error does not pause the run's phase. */
  job?: () => Promise<void>;
  /** The program's extra request line for a card (source swap or automatic redo). */
  extra: Map<string, string>;
  /** Cards whose `extra` line is a source swap: the author gets it too. */
  avoid: Set<string>;
  /** Cards whose proofread named unmet points, waiting for the one automatic redo once every card has had its first round: the program-built request line. */
  fixable: Map<string, string>;
  /** Cards whose automatic redo edits the chapter in place (the program puts the author's change blocks in), never writing it anew. */
  expand: Set<string>;
  /** The reader's one-time permission to rewrite a hand-edited chapter: bound to the run, the card, the operation and the text it was given for. */
  overwrite: Map<string, { runId: string; operation: string; fingerprint: string }>;
  /** In memory only: the single-card rerun in progress. */
  rerun?: { nodeId: string; startedAt: number };
  /** The plan a card's plan step wrote in this drive. */
  plans: Map<string, CardPlanResult>;
  /** Chapters this drive's plan step left alone (hand-edited, unknown or kept): their previous/next lines are refreshed by the program. */
  planSkipped: Set<string>;
  /**
   * Chapters whose Summary is the reader's own (a kept chapter, or text the pipeline never wrote): decided at the first plan step of this
   * drive, before anything of the program is in the note. Their plan and write leave the Summary as it is.
   */
  ownSummary: Set<string>;
  /** The skipped chapters' neighbour lines were refreshed once for this order (cleared when the map changes). */
  skippedRefreshed?: boolean;
  /** The model id each card's author step was dispatched with in this drive (the proof result section shows it). */
  authorModels: Map<string, string>;
  /** When each card's first step started in this drive, and the durations (ms) of the cards that finished their phase. */
  started: Map<string, number>;
  durations: { plan: number[]; write: number[] };
  /** In memory only: the sub-step each running card (or `global`) is in, and the cards whose pictures are in but whose write step has not ended. */
  sub: Map<string, { step: BookSubStep; startedAt: number }>;
  imagesDone: Set<string>;
  /** In memory only: the step that marked each card needs-review in this drive. */
  reviewStep: Map<string, PipelineStep>;
  fatal?: unknown;
  /** A neutral code of why the run ended by itself (see failRun). */
  failure?: string;
  /** Keys (see imageKey) of the pictures this run already embedded: one picture is used once in a book. */
  usedImages: Set<string>;
  /** The 429 waits this run spent on Wikimedia Commons, all chapters together (see COMMONS_RUN_BACKOFF_MS). */
  commonsBudget: CommonsRunBudget;
  /** Work keys (see workKey) this run placed, by the card that placed them: one work is shown once in a book, even under another file name. */
  usedWorks: Map<string, string>;
  /** The drive-wide gate of picture probes in flight (see {@link PROBE_PARALLEL}). */
  probeGate: { active: number; waiters: Array<() => void> };
  done: Promise<void>;
}

const code = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "failed";
const reasonOf = (error: unknown): string =>
  isProofFailure(error) ? error.code : isBookStepError(error) ? "invalid_reply" : "failed";
/** An unexpected error's code: only its class name, never its message (which could carry a path or a title). */
const internalCode = (error: unknown): string =>
  `internal_${(typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
/** Failure reasons after which the card's proof-result section is not written (the write never reached the card, or the card is gone). */
const NO_FAILURE_SECTION: ReadonlySet<string> = new Set([
  "discarded",
  "card_removed",
  "backup_failed",
  "missing",
  "hand_edited"
]);
const STEP_OF = { card_plan: "plan", card_write: "write", card_proof: "proof" } as const;
const ACTION_OF = { plan: "card_plan", write: "card_write", proof: "card_proof" } as const;
/** How many characters of one chapter's covers line the proofread gets (15 chapters stay a few thousand characters). */
const PROOF_COVERS_MAX = 160;
const singleLineText = (value: string, max: number): string =>
  Array.from(value.replace(/\s+/g, " ").trim()).slice(0, max).join("");

const DEFINITION = /^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:<([^>\n]*)>|(\S+))[^\n]*(?:\n|$)/gm;
const WIKI_TARGET = /^[^[\]()!<>\r\n\\]+$/;
const SCHEME = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;
const frontmatterLength = (content: string): number =>
  /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(content)?.[0].length ?? 0;
const labelOf = (value: string): string => value.trim().replace(/\s+/g, " ").toLowerCase();
/** Every tag or comment start (also a `<` ending a chunk, which an image follows) becomes `&lt;`; only the note's own section markers (an exact comment with no payload) stay. */
const neutralize = (text: string): string =>
  text.replace(/<(?=[A-Za-z/!?]|$)(?!!-- visual-agent-map:(?:detail|references):(?:start|end) -->)/g, "&lt;");
/**
 * The machine line of a stored proof record (`<!-- book-proof:v1 {json} -->`, also as a `> ` quote line of the callout) must pass the
 * body cleaning byte for byte: a rerun's author step keeps the old records, and neutralize would turn their `<` into `&lt;`.
 * Only a line that is one comment with a JSON payload holding no `<` and no `-->` is held back; any other `<!--` is cleaned as before.
 */
const PROOF_LINE = /^(?:[ \t]{0,3}>[ \t]?)?<!-- book-proof:v1 (\{[^<]*\}) -->$/;
function holdProofLines(
  content: string,
  known: ReadonlySet<string>
): { text: string; restore: (cleaned: string) => string } {
  const held: string[] = [];
  const token = `VAMPROOFLINE${Math.random().toString(36).slice(2)}X`;
  const text = content
    .split("\n")
    .map(line => {
      const m = PROOF_LINE.exec(line.replace(/\r$/, ""));
      // Only a line that was already in the card before the author ran: a record the author wrote is model text, never a stored proof.
      if (!m || m[1].includes("-->") || !known.has(line)) return line;
      try {
        JSON.parse(m[1]);
      } catch {
        return line;
      }
      held.push(line);
      return `${token}${held.length - 1}X`;
    })
    .join("\n");
  return {
    text,
    restore: cleaned => cleaned.replace(new RegExp(`${token}(\\d+)X`, "g"), (_, i: string) => held[Number(i)])
  };
}
/**
 * A strict source anchor `<a href="https://…">text</a>` (each `<`, `>` and `"` also as its entity, decoded one level only), with
 * `href` as the only attribute, one line, no tag inside. Anything else (another attribute, a nested or unclosed tag, `javascript:`,
 * `http:`, a doubled entity) does not match and stays plain text for the cleaning that follows.
 */
const ANCHOR =
  /(?:<|&lt;)a[ \t]+href=(?:"|&quot;)([^"<>\n]*?)(?:"|&quot;)[ \t]*(?:>|&gt;)([^<>\n]*?)(?:<|&lt;)\/a[ \t]*(?:>|&gt;)/gi;
/**
 * R1-6: the body (after the frontmatter) with every strict https anchor written as the markdown link `[text](href)`: the address
 * must pass {@link safeLinkHref}, the text is escaped plain text, and a space goes before the link when a `!` or `\` precedes it (so
 * it can never become an image or an escape). The caller runs the picture scan and the tag cleaning on the result.
 */
export function convertSourceAnchors(content: string): string {
  const at = frontmatterLength(content);
  const lines = content.slice(at).split("\n");
  const fenced = fencedLines(lines);
  return (
    content.slice(0, at) +
    lines
      .map((line, index) => {
        if (fenced[index]) return line;
        // Inline code spans (a backtick run to the same run) are shown as written, so an anchor inside one stays.
        const spans: Array<[number, number]> = [];
        for (const m of line.matchAll(/(`+)(?!`).+?(?<!`)\1(?!`)/g)) spans.push([m.index, m.index + m[0].length]);
        return line.replace(ANCHOR, (whole: string, rawHref: string, rawText: string, offset: number, all: string) => {
          if (spans.some(([from, to]) => offset >= from && offset < to)) return whole;
          if (/&(?:lt|gt|quot);/i.test(rawText) || /&(?:lt|gt|quot);/i.test(rawHref.replace(/&amp;/g, "")))
            return whole;
          const href = safeLinkHref(rawHref.replace(/&amp;/g, "&"));
          const text = escapeMarkdownText(rawText.replace(/&amp;/g, "&"), 200);
          if (!href || !text) return whole;
          // Nested: an earlier anchor on this line is still open, so this one sits inside it.
          const prefix = all.slice(0, offset);
          if ((prefix.match(/(?:<|&lt;)a[ \t]/gi)?.length ?? 0) > (prefix.match(/(?:<|&lt;)\/a/gi)?.length ?? 0))
            return whole;
          const before = all[offset - 1];
          return `${before === "!" || before === "\\" ? " " : ""}[${text}](${href})`;
        });
      })
      .join("\n")
  );
}
const NO_PICTURE = "無圖：";
const PICTURE_REASONS: Record<string, [string, string]> = {
  unsafe: ["網址不安全", "unsafe address"],
  load_failed: ["無法載入", "could not load"],
  empty: ["空圖", "empty image"],
  timeout: ["逾時", "timed out"],
  aborted: ["已中止", "aborted"]
};
/** The "no picture" line for a probe reason code (a known code in the output language; anything else is escaped text). */
function noPicture(language: string, reason: string): string {
  const known = Object.prototype.hasOwnProperty.call(PICTURE_REASONS, reason) ? PICTURE_REASONS[reason] : undefined;
  const zh = /^zh/i.test(language);
  const text = known ? known[zh ? 0 : 1] : escapeMarkdownText(reason, 60) || (zh ? "載入失敗" : "load failed");
  return zh ? `${NO_PICTURE}${text}` : `No picture: ${text}`;
}
/** Picture probes of one chapter (at most 36 distinct addresses: {@link MAX_IMAGE_SLOTS} slots of 3 candidates) and probes in flight in the whole run. */
export const PROBE_PER_CHAPTER = MAX_IMAGE_SLOTS * 3;
export const PROBE_PARALLEL = 4;
const SEARCH_TEXT_MAX = 400;
/** The chapter's search text: its title, summary and (at most five) `《work》` names from the text, one line with no address in it. */
function imageSearchText(card: PipelineCard): string {
  const works = [...new Set([...chapterBody(card.detail).matchAll(/《([^《》\n]{1,40})》/g)].map(m => m[1]))].slice(
    0,
    5
  );
  return singleLineText(
    [card.title, card.summary, ...works.map(work => `《${work}》`)]
      .filter(Boolean)
      .join(" / ")
      .replace(/\S*:\/\/\S*/g, " "),
    SEARCH_TEXT_MAX
  );
}
const isHttps = (url: string): boolean => /^https:\/\//i.test(url);

/**
 * A public web host only (a front guard: an `<img>` that follows a redirect to an inner address is not stopped here). Refuses IP literals
 * (WHATWG parsing has already turned decimal / octal / hex forms into dotted IPv4), localhost, hosts ending in local, internal or lan, a one-label host,
 * credentials and a port other than 443.
 */
function isPublicHost(url: URL): boolean {
  if (url.username || url.password || (url.port && url.port !== "443")) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("@") || host.startsWith("[") || /^[\d.]+$/.test(host) || !host.includes(".")) return false;
  if (/^(0x[0-9a-f]*|\d+)(\.(0x[0-9a-f]*|\d+))*$/.test(host)) return false;
  return !/(^|[.])(localhost|local|internal|lan)$/.test(host);
}

/** An address that may be probed and written back: no whitespace, backslash, `<` or `>`; `new URL()` parses it as https with balanced parentheses. */
function safeHref(raw: string): string | undefined {
  if (!raw || /[\s\\<>\p{Cc}]/u.test(raw)) return undefined;
  let href: string;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !isPublicHost(url)) return undefined;
    href = url.href;
  } catch {
    return undefined;
  }
  let depth = 0;
  for (const c of href) {
    if (c === "(") depth++;
    else if (c === ")" && --depth < 0) return undefined;
  }
  return depth === 0 ? href : undefined;
}

type Resolve = (href: string) => string | undefined;
/** Parses an inline destination starting right after `(`; undefined when the form is not the plain `url "title"` shape. */
function inlineTarget(text: string, from: number): { raw: string; end: number } | undefined {
  let p = from;
  while (text[p] === " " || text[p] === "\t") p++;
  let raw: string;
  if (text[p] === "<") {
    const q = text.indexOf(">", p + 1);
    if (q < 0) return undefined;
    raw = text.slice(p + 1, q);
    if (/[\n<]/.test(raw)) return undefined;
    p = q + 1;
  } else {
    const start = p;
    let depth = 0;
    while (p < text.length && !/\s/.test(text[p])) {
      if (text[p] === "\\") p++;
      else if (text[p] === "(") depth++;
      else if (text[p] === ")" && depth-- === 0) {
        depth = 0;
        break;
      }
      p++;
    }
    raw = text.slice(start, p);
  }
  while (text[p] === " " || text[p] === "\t") p++;
  const quote = text[p] === '"' ? '"' : text[p] === "'" ? "'" : text[p] === "(" ? ")" : "";
  if (quote) {
    const q = text.indexOf(quote, p + 1);
    if (q < 0 || /\n/.test(text.slice(p, q))) return undefined;
    p = q + 1;
    while (text[p] === " " || text[p] === "\t") p++;
  }
  return text[p] === ")" ? { raw, end: p + 1 } : undefined;
}

/** Rebuilds every image of one stretch of plain text: whatever is understood is rewritten to the standard form (or a "no picture" line), whatever is not loses its `!`. */
function rebuildImages(text: string, defs: Map<string, string>, used: Set<string>, resolve: Resolve): string {
  let out = "";
  let plain = 0;
  let i = 0;
  const unsupported = (at: number): void => {
    out += neutralize(text.slice(plain, at)) + `${NO_PICTURE}形式不支援`;
    i = at + 1;
    plain = i;
  };
  for (let at = text.indexOf("![", i); at >= 0; at = text.indexOf("![", i)) {
    if (text[at + 2] === "[") {
      const end = text.indexOf("]]", at + 3);
      const target = end < 0 ? "" : text.slice(at + 3, end);
      if (end < 0 || !WIKI_TARGET.test(target) || SCHEME.test(target)) {
        unsupported(at);
        continue;
      }
      out += neutralize(text.slice(plain, at)) + `![[${target}]]`;
      i = end + 2;
      plain = i;
      continue;
    }
    let j = at + 2;
    while (j < text.length && text[j] !== "]" && text[j] !== "[" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
    if (text[j] !== "]") {
      unsupported(at);
      continue;
    }
    const alt = text.slice(at + 2, j);
    let raw: string | undefined;
    let end = j + 1;
    if (text[end] === "(") {
      const target = inlineTarget(text, end + 1);
      raw = target?.raw;
      end = target?.end ?? -1;
    } else {
      let label = alt;
      if (text[end] === "[") {
        const q = text.indexOf("]", end + 1);
        const inner = q < 0 ? "" : text.slice(end + 1, q);
        if (q < 0 || /[[\n]/.test(inner)) end = -1;
        else {
          if (inner.trim()) label = inner;
          end = q + 1;
        }
      }
      if (end >= 0) {
        const key = labelOf(label);
        raw = defs.get(key);
        if (raw !== undefined) used.add(key);
      }
    }
    if (end < 0 || raw === undefined) {
      unsupported(at);
      continue;
    }
    const href = safeHref(raw);
    const failure = href ? resolve(href) : `${NO_PICTURE}網址不安全`;
    out += neutralize(text.slice(plain, at));
    out += failure ?? `![${escapeMarkdownText(unescapeMarkdownText(alt), 200)}](${href})`;
    i = end;
    plain = i;
  }
  return out + neutralize(text.slice(plain));
}

/**
 * Allow-list rebuild of a note's body (the frontmatter stays as it is). Code is not exempt: in the whole body
 * every image (inline, reference or `![[...]]`) is parsed conservatively and written again in the standard form `![alt](href)`
 * (https only, address from `new URL()`, title dropped), or becomes a "no picture" line when `resolve(href)` gives a reason, the
 * address is not https or the form is not understood; the definition lines that reference images used are removed; every HTML tag
 * or comment start `<` becomes `&lt;` (only the app's own section markers stay). Nothing of the original image text is kept.
 * {@link unsafeBody} then checks the result.
 */
function rebuildBody(content: string, resolve: Resolve): string {
  const at = frontmatterLength(content);
  const body = content.slice(at);
  const defs = new Map<string, string>();
  for (const m of body.matchAll(DEFINITION)) {
    const label = labelOf(m[1]);
    if (!defs.has(label)) defs.set(label, m[2] ?? m[3] ?? "");
  }
  const used = new Set<string>();
  rebuildImages(body, defs, used, resolve);
  const text = body.replace(DEFINITION, (line, label: string) => (used.has(labelOf(label)) ? "" : line));
  return content.slice(0, at) + rebuildImages(text, defs, used, resolve);
}

const MARKERS = /<!-- visual-agent-map:(?:detail|references):(?:start|end) -->/g;
/**
 * Exit check, independent of the rebuild: true when the body of `content` still has an HTML tag start (the app's markers aside),
 * an `![alt](url)` whose url is not one of `allowed` (the https addresses that were probed), any other `![` form, or an `![[...]]`
 * that is not plain safe text without a scheme.
 */
export function unsafeBody(content: string, allowed: ReadonlySet<string>): boolean {
  const body = content.slice(frontmatterLength(content)).replace(MARKERS, " ");
  if (/<[A-Za-z/!?]/.test(body)) return true;
  for (let at = body.indexOf("!["); at >= 0; at = body.indexOf("![", at + 2)) {
    if (body[at + 2] === "[") {
      const end = body.indexOf("]]", at + 3);
      const target = end < 0 ? "" : body.slice(at + 3, end);
      if (end < 0 || !WIKI_TARGET.test(target) || SCHEME.test(target)) return true;
      continue;
    }
    const head = /^!\[(?:\\.|[^\\[\]\n])*\]\(/.exec(body.slice(at, at + 4000));
    if (!head) return true;
    let p = at + head[0].length;
    let depth = 0;
    while (p < body.length && !/\s/.test(body[p]) && (body[p] !== ")" || depth > 0)) {
      if (body[p] === "(") depth++;
      else if (body[p] === ")") depth--;
      p++;
    }
    // The address as written or in the standard form the cleaning gives it (live v5: a raw non-ASCII or upper-case https address of an
    // allowed picture refused a whole expansion); anything that does not parse as a safe https address must be listed as written.
    const href = body.slice(at + head[0].length, p);
    if (body[p] !== ")" || !(allowed.has(href) || allowed.has(safeHref(href) ?? ""))) return true;
  }
  return false;
}

/** The lines of `text` that `base` does not have (counted: a line twice in `text` and once in `base` is new once). */
export function addedLines(text: string, base: string): string[] {
  const pool = new Map<string, number>();
  for (const line of base.split("\n")) pool.set(line, (pool.get(line) ?? 0) + 1);
  return text.split("\n").filter(line => {
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    return left === 0;
  });
}

/**
 * The check of an expanded chapter, run on the text about to be saved: the lines it has that the chapter before did not (`oldDetail`)
 * must hold no hidden callout type or owner marker, no HTML tag or comment, and only pictures whose address is in `allowed` (the old
 * chapter's and the cleaned answer's https addresses); a picture-slot marker line must be one the cleaned answer has (`answerLines`).
 * `unsafe` is the body exit check. True means the write is refused.
 */
export function expansionUnsafe(
  detail: string,
  oldDetail: string,
  answerLines: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  unsafe: (content: string, allowed: ReadonlySet<string>) => boolean = unsafeBody
): boolean {
  return expansionUnsafeRule(detail, oldDetail, answerLines, allowed, unsafe) !== undefined;
}
/** Which rule of {@link expansionUnsafe} refuses the text (`hidden_callout`, `slot_marker`, `body`, `picture`), or undefined: the log names it. */
export function expansionUnsafeRule(
  detail: string,
  oldDetail: string,
  answerLines: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  unsafe: (content: string, allowed: ReadonlySet<string>) => boolean = unsafeBody
): string | undefined {
  const added = addedLines(detail, oldDetail);
  const text = added.join("\n");
  if (neutralizeText(text) !== text) return "hidden_callout";
  if (added.some(line => residualMarkerLines(line).length > 0 && !answerLines.has(line))) return "slot_marker";
  // The leading line break: added text that starts with `---` is never read as frontmatter (and so skipped).
  if (unsafe(`\n${text}`, allowed)) return "body";
  return bodyImageUrls(`\n${text}`).some(url => !allowed.has(url)) ? "picture" : undefined;
}

/** The distinct addresses (standard form) of a note's body that an image would load and that may be probed: https only; never the frontmatter. */
export function bodyImageUrls(content: string): string[] {
  const urls = new Set<string>();
  rebuildBody(content, href => {
    urls.add(href);
    return undefined;
  });
  return [...urls];
}
/** The allow-list rebuild of a note's body: `replacements` maps an address (as {@link bodyImageUrls} gave it) to the "no picture" line that replaces its image. */
export function replaceBodyImages(content: string, replacements: ReadonlyMap<string, string>): string {
  return rebuildBody(content, href => replacements.get(href));
}

/** The neighbour's "join not yet checked" line (a rerun and an applied note both write it). */
function seamText(language: string, at: number, revision: number | string): string {
  return /^zh/i.test(language)
    ? `鄰卡企劃或正文已變更，尚未人工核對（第 ${at + 1} 張，版本 ${revision}）`
    : `Neighbouring card's plan or text changed; not yet checked by a person (card ${at + 1}, revision ${revision})`;
}

/** What one apply-notes job did. `edits` carry the before/after of each replaced paragraph (the undo's input). */
export interface NotesApplyResult {
  applied: number;
  skipped: number;
  marked: number;
  edits: AppliedEdit[];
  /** Paragraphs whose rewrite was refused (left alone, note kept), with the reason. */
  refused?: { id: string; reason: string }[];
}

export class BookPipelineRuns {
  private readonly drives = new Map<string, Drive>();
  private readonly last = new Map<string, BookPipelineProgress>();
  /** The notes slot: one apply-notes job per map, exclusive with a drive (both directions are checked synchronously). */
  private readonly notesJobs = new Map<string, AbortController>();
  private disposed = false;

  constructor(private readonly ports: BookPipelinePorts) {}

  isRunning(mapPath: string): boolean {
    return this.drives.has(mapPath);
  }
  /** True while an apply-notes job holds this map. */
  isApplyingNotes(mapPath: string): boolean {
    return this.notesJobs.has(mapPath);
  }
  /** Cancels the map's apply-notes job: nothing is written after this, a late answer is dropped. */
  cancelNotes(mapPath: string): void {
    this.notesJobs.get(mapPath)?.abort();
  }

  /** The live drive's numbers, or what the last drive left; undefined when this plugin session never ran the map. */
  getProgress(mapPath: string): BookPipelineProgress | undefined {
    const drive = this.drives.get(mapPath);
    // A drive whose first write is still in progress has no store yet (a repaint during that write asks): nothing to report yet.
    if (drive) return drive.store ? this.progressOf(drive, true) : undefined;
    return this.last.get(mapPath);
  }

  /** Starts a new run (writes `bookPipeline` to the map file) and drives it until it ends, pauses or reaches a gate. */
  async start(mapPath: string, options: { restart?: boolean } = {}): Promise<void> {
    // A restart (the stopped bar's "reconfigure and start over") may replace a run that is stopped in any phase before done; nothing else.
    const replaceable = (data: BookPipelineData): boolean =>
      data.phase === "done" || (options.restart === true && data.status === "stopped");
    return this.enter(mapPath, async drive => {
      if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
      const runId = this.ports.newId();
      let initial: BookPipelineData | undefined;
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const map = await this.ports.readMap(mapPath);
        const read = readBookPipeline(map);
        if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
        if (read.kind === "usable" && !replaceable(read.data)) throw new BookPipelineRunError("exists");
        const order = this.orderOf(map);
        // Roles the previous run's pipeline wrote (defaults and plan choices) are not the owner's; only roles written outside the pipeline are.
        const prior = read.kind === "usable" ? (read.data.autoRoles ?? []) : [];
        await this.load(drive, map, order, new Set(prior));
        const stale = order.filter(id => drive.stages.get(id) !== undefined);
        const state = newBookPipeline({
          runId,
          order,
          trial: this.structureOf(drive, order).trialOf(),
          now: this.ports.now(),
          staleStages: stale,
          chapters: Object.fromEntries(
            order.flatMap(id => {
              const info = drive.cards.get(id);
              return info ? [[id, { title: info.title, path: info.path }]] : [];
            })
          ),
          autoRoles: [...new Set([...prior.filter(id => order.includes(id)), ...drive.missingRoles.keys()])]
        });
        if (this.dead(drive)) return;
        // The old run's callouts go first; a failure is logged and the next map opening cleans what is left (other run id).
        if (read.kind === "usable") await this.ports.callouts?.clear(mapPath);
        if (this.dead(drive)) return;
        await this.ports.updateMap(mapPath, doc => {
          const found = readBookPipeline(doc);
          if (found.kind === "unusable" || (found.kind === "usable" && !replaceable(found.data)))
            throw new BookPipelineRunError("exists");
          doc.bookPipeline = state;
        });
        initial = state;
        // First start: a missing role gets its default (root and first-level topics intro, the rest body); an existing one is kept.
        for (const [id, role] of drive.missingRoles) await this.writeRole(drive, id, role);
        drive.missingRoles.clear();
        // Attach right after the write: the repaint that follows it (main.mutate reads the views back) already asks for progress.
        this.attachStore(drive, state);
      });
      if (!initial || this.dead(drive)) return;
      this.log(drive, "start", "-", "plan", "ok");
    });
  }

  /**
   * "Give up this book": removes `bookPipeline` from the map file so it is a normal mind map again. Only for a run that is stopped (or
   * interrupted) or done, and never beside a drive of the map. No note is read or written; backups stay. The progress record the
   * plugin kept for the map is dropped with it.
   */
  async abandon(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
      await this.ports.mutate(async () => {
        if (this.dead(drive)) return;
        const found = readBookPipeline(await this.ports.readMap(mapPath));
        if (found.kind === "absent") throw new BookPipelineRunError("missing");
        if (found.kind === "unusable") throw new BookPipelineRunError("unusable");
        const waiting =
          (found.data.phase === "gate1" || found.data.phase === "gate2") && found.data.status === "running";
        if (waiting) throw new BookPipelineRunError("not_stopped");
        // The run's callouts go before the run does: afterwards no order is left to find them by.
        await this.ports.callouts?.clear(mapPath);
        if (this.dead(drive)) return;
        await this.ports.updateMap(mapPath, doc => {
          const again = readBookPipeline(doc);
          if (again.kind !== "usable" || again.data.runId !== found.data.runId)
            throw new BookPipelineRunError("not_stopped");
          delete doc.bookPipeline;
        });
        this.last.delete(mapPath);
      });
    });
  }

  /** Continues a stopped (or interrupted) run from the cards' stages; `addBudget` first raises the call limit (the "add 100" button). */
  async resume(mapPath: string, options: { addBudget?: number } = {}): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath);
      const extra = options.addBudget ?? 0;
      let refused = false;
      await drive.store.commit(state => {
        let next = retryGlobalPlan(recoverInterrupted(state));
        if (extra) next = addBudget(next, extra);
        const resumed = resumeRun(next);
        refused = resumed === null;
        return { state: resumed ?? next, accepted: true };
      });
      if (refused) throw new BookPipelineRunError("budget");
      // The fix instruction lived only in memory: a card still waiting for its one rewrite goes back to needs-review (its fix is spent).
      for (const id of effectiveOrder(drive.store.state))
        if (drive.stages.get(id) === "planned" && autoFixesOf(drive.store.state, id) > 0 && !drive.extra.has(id)) {
          drive.stages.set(id, "needs-review");
          await this.writeFields(drive, id, {
            pipelineStage: "needs-review",
            pipelineIssue: "proof unmet: fix interrupted"
          });
        }
      this.log(drive, "resume", "-", "plan", data.status === "running" ? "recovered" : "ok");
    });
  }

  /** The owner confirmed gate 1: writing starts (or a stopped run at gate 1 continues into it). */
  async confirmGate1(mapPath: string): Promise<void> {
    return this.enter(
      mapPath,
      async drive => {
        await this.openSaved(drive, mapPath);
        let moved = false;
        await drive.store.commit(state => {
          const next = confirmGate1(resumeRun(state) ?? state, this.ports.now());
          moved = next.phase !== state.phase;
          return { state: moved ? next : state, accepted: true };
        });
        if (!moved) throw new BookPipelineRunError("not_gate1");
        this.log(drive, "gate1", "-", "write", "confirmed");
      },
      true
    );
  }

  /**
   * The owner accepted gate 2: the run is done. Only at gate 2; a run that is already done answers as if nothing happened (a second
   * press is harmless), any other phase is refused. Cards are not touched.
   */
  async finishRun(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      if (data.phase === "done") return;
      if (data.phase !== "gate2") throw new BookPipelineRunError("not_gate");
      // The map's cards differ from the book's chapters: the run pauses as "map changed" (the bar offers replan / keep / stop) instead of finishing.
      const change = mapDifference(data, this.mapIds(await this.ports.readMap(mapPath)));
      if (change.added.length || change.missing.length) {
        await drive.store.commit(state => ({ state: pauseForMap(state, change), accepted: true }));
        this.log(drive, "map_changed", "-", "proof", `added:${change.added.length},missing:${change.missing.length}`);
        return;
      }
      let refusal: BookRunRefusal | undefined;
      await drive.store.commit(state => {
        const running = resumeRun(state);
        if (!running) {
          refusal = "budget";
          return { state, accepted: true };
        }
        const next = finishRun(running, this.ports.now());
        if (next.phase === state.phase) refusal = "not_gate";
        return { state: refusal ? state : next, accepted: true };
      });
      if (refusal) throw new BookPipelineRunError(refusal);
      this.log(drive, "gate2", "-", "proof", "finished");
    });
  }

  /**
   * Gate 1 of a run with a trial: the owner changed the settings or models and wants the trial cards again. The run goes back to
   * planning, only the trial cards start over (stage, attempts, automatic redo, their own pictures are free to use again), and the
   * drive runs them through plan, write, pictures and proofread to gate 1 again. Refused (not_gate1) at any other phase or for a run
   * without a trial.
   */
  async retryTrial(mapPath: string): Promise<void> {
    return this.enter(
      mapPath,
      async drive => {
        await this.openSaved(drive, mapPath);
        let moved = false;
        await drive.store.commit(state => {
          const next = retryTrial(resumeRun(state) ?? state, this.ports.now());
          moved = next.phase !== state.phase;
          return { state: moved ? next : state, accepted: true };
        });
        if (!moved) throw new BookPipelineRunError("not_gate1");
        for (const id of drive.store.state.trial ?? []) {
          const own = drive.cards.get(id);
          const current = own ? await this.ports.readCard(own.path).catch(() => undefined) : undefined;
          if (current) for (const url of bodyImageUrls(current.detail)) drive.usedImages.delete(imageKey(url));
        }
        this.log(drive, "gate1", "-", "plan", "trial_retry");
      },
      true
    );
  }

  /** The plan review: the owner chose to run the trial. The trial chapters are written from their plans as they are now. Refused (not_gate1) elsewhere. */
  async startTrial(mapPath: string): Promise<void> {
    return this.enter(
      mapPath,
      async drive => {
        await this.openSaved(drive, mapPath);
        let moved = false;
        await drive.store.commit(state => {
          const next = startTrial(resumeRun(state) ?? state, this.ports.now());
          moved = next.phase !== state.phase;
          return { state: moved ? next : state, accepted: true };
        });
        if (!moved) throw new BookPipelineRunError("not_gate1");
        this.log(drive, "gate1", "-", "write", "trial_start");
      },
      true
    );
  }

  /**
   * The trial's gate 1: the owner wants to change the plan first. The run returns to the plan review; the trial chapters go back to
   * planned (their plans stay for the owner to edit; their text stays until the next trial rewrites it). Refused (not_gate1) elsewhere.
   */
  async backToPlan(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      await this.openSaved(drive, mapPath);
      let moved = false;
      await drive.store.commit(state => {
        const next = backToPlan(resumeRun(state) ?? state, this.ports.now());
        moved = next.planReview === true && state.planReview !== true;
        return { state: moved ? next : state, accepted: true };
      });
      if (!moved) throw new BookPipelineRunError("not_gate1");
      for (const id of drive.store.state.trial ?? []) {
        const own = drive.cards.get(id);
        if (!own || drive.stages.get(id) === undefined) continue;
        const current = await this.ports.readCard(own.path).catch(() => undefined);
        if (current) for (const url of bodyImageUrls(current.detail)) drive.usedImages.delete(imageKey(url));
        drive.stages.set(id, "planned");
        await this.writeFields(drive, id, { pipelineStage: "planned", pipelineIssue: null });
      }
      this.log(drive, "gate1", "-", "plan", "back_to_plan");
    });
  }

  /**
   * One card again (gate 2 or done): plan, author, proofread with the usual per-step retries, fence, backup and
   * budget rules; the card gets a new revision (so a new proof record; older records stay, marked old). The cards on both sides are
   * not touched except for the seam mark. The run's phase does not change, and it cannot run beside another drive of the map.
   */
  async rerunCard(
    mapPath: string,
    nodeId: string,
    options: {
      avoidSources?: readonly string[];
      /** The reader's one-time permission to rewrite a hand-edited chapter: bound to this operation and the text (its integrity fingerprint) it was given for. */
      overwrite?: { operation: string; fingerprint: string };
    } = {}
  ): Promise<BookRerunResult> {
    const swap = options.avoidSources !== undefined;
    let result: BookRerunResult = { unchanged: false };
    await this.cardJob(
      mapPath,
      nodeId,
      ["gate2", "done"],
      "not_gate",
      () => ["plan", "write", "proof"],
      swap ? avoidSourcesInstruction(options.avoidSources ?? []) : undefined,
      (drive, snapshots) => {
        // A stopped, replaced or removed run says nothing about the result.
        const settled = !drive.controller.signal.aborted && !this.dead(drive) && drive.fatal === undefined;
        result = { unchanged: settled && sameReviewResult(snapshots?.before, snapshots?.after) };
      },
      true,
      swap,
      options.overwrite
    );
    return result;
  }

  /** The owner's "seam checked" clears `pipeline-seam` (a proofread never does; a whole-book rewrite does, see `clearSeams`). */
  async confirmSeam(mapPath: string, nodeId: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      const map = await this.ports.readMap(mapPath);
      const read = readBookPipeline(map);
      if (read.kind === "absent") throw new BookPipelineRunError("missing");
      if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
      const node = map.nodes.find(item => item.id === nodeId);
      if (!node || !effectiveOrder(read.data).includes(nodeId)) throw new BookPipelineRunError("missing");
      if (this.dead(drive)) throw new BookPipelineRunError("disposed");
      const card = await this.ports.readCard(node.path).catch(() => undefined);
      if (!card) throw new BookPipelineRunError("unreadable");
      if (card.fields.pipelineSeam === undefined) return;
      await this.ports.writePipelineFields(node.path, { pipelineSeam: null });
      this.ports.log(
        formatPipelineLog({
          event: "seam_confirmed",
          runId: read.data.runId,
          card: nodeId,
          step: "proof",
          attempt: 0,
          result: "ok",
          ms: 0
        })
      );
    });
  }

  private cardJob(
    mapPath: string,
    nodeId: string,
    phases: readonly PipelinePhase[],
    refusal: BookRunRefusal,
    steps: (phase: PipelinePhase) => PipelineStep[],
    extra?: string,
    finish?: (drive: Drive, snapshots?: { before?: CardResultSnapshot; after?: CardResultSnapshot }) => void,
    /** A rerun: its time is shown, and the card's result is compared before and after. */
    track = false,
    /** The extra line is the program's source swap: the author gets it too. */
    swap = false,
    /** A rewrite the reader allowed over a hand-edited chapter (see {@link BookPipelineRuns.rerunCard}). */
    overwrite?: { operation: string; fingerprint: string }
  ): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      if (!effectiveOrder(data).includes(nodeId)) throw new BookPipelineRunError("missing");
      if (!phases.includes(data.phase)) throw new BookPipelineRunError(refusal);
      if (overwrite) {
        // Bound to the text it was given for: if the chapter changed since, nothing is rewritten (the write checks again inside itself).
        const path = drive.cards.get(nodeId)?.path;
        const current = path ? await this.ports.readCard(path).catch(() => undefined) : undefined;
        if (!current) throw new BookPipelineRunError("unreadable");
        if (integrityFpRaw(current.raw) !== overwrite.fingerprint) throw new BookPipelineRunError("text_changed");
        drive.overwrite.set(nodeId, { runId: data.runId, ...overwrite });
      }
      let refused = false;
      await drive.store.commit(state => {
        const next = resumeRun(state);
        refused = next === null;
        return { state: next ?? state, accepted: true };
      });
      if (refused) throw new BookPipelineRunError("budget");
      if (extra) drive.extra.set(nodeId, extra);
      if (extra && swap) drive.avoid.add(nodeId);
      if (extra) drive.expand.delete(nodeId);
      const kinds = steps(data.phase);
      drive.job = async () => {
        const before = track ? await this.cardSnapshot(drive, nodeId) : undefined;
        const planBefore = drive.plans.get(nodeId);
        if (track) drive.rerun = { nodeId, startedAt: Date.parse(this.ports.now()) };
        try {
          await this.runCardJob(drive, nodeId, kinds);
        } finally {
          drive.rerun = undefined;
        }
        if (track) await this.proofAfterRerun(drive, nodeId);
        // A rerun that made a new plan: the neighbours' plans still describe the old one (no AI call, only their previous/next line).
        if (track && drive.plans.get(nodeId) !== planBefore) await this.refreshNeighbourPlans(drive, nodeId);
        finish?.(drive, track ? { before, after: await this.cardSnapshot(drive, nodeId) } : undefined);
        this.syncReviewNotes(drive);
      };
      this.log(drive, "rerun", nodeId, kinds[0], kinds.length === 1 ? "plan_only" : "full");
    });
  }

  /**
   * A chapter written again after its chapter proofread was cleared (`resetCard`): the AI proofread runs on it here, in the same job (the
   * usual rounds and limits), and a finished book's closing page is written again, so the bar, the chapter box and the page agree.
   * A failed page write is logged and the book stays as it was (a finished book is not turned back).
   */
  private async proofAfterRerun(drive: Drive, nodeId: string): Promise<void> {
    if (!this.ports.aiProof || !this.ports.aiFix || !this.ports.aiBookProof) return;
    const stage = drive.stages.get(nodeId);
    if (stage !== "checked" && stage !== "needs-review") return;
    for (let turn = 0; turn < 20; turn++) {
      const state = drive.store.state;
      if (this.dead(drive) || drive.controller.signal.aborted || drive.fatal !== undefined) return;
      if (state.status !== "running" || state.aiProof?.[nodeId]?.done) break;
      drive.busy.add(nodeId);
      try {
        await this.aiChapter(drive, nodeId, state.aiProof?.[nodeId]?.step === "fix" ? "fix" : "proof", true);
      } finally {
        drive.busy.delete(nodeId);
      }
    }
    if (drive.store.state.phase !== "done" || !drive.store.state.aiProof?.[nodeId]?.done) return;
    if (!(await this.writeClosingPage(drive))) this.log(drive, "open_issues_write", nodeId, "proof", "failed");
  }

  /** The card's result as the rerun compares it (memory only); undefined when the card cannot be read. */
  private async cardSnapshot(drive: Drive, nodeId: string): Promise<CardResultSnapshot | undefined> {
    const path = drive.cards.get(nodeId)?.path;
    if (!path) return undefined;
    try {
      const card = await this.ports.readCard(path);
      return cardResultSnapshot(card.fields.pipelineStage, card.fields.pipelineIssue, card.detail);
    } catch {
      return undefined;
    }
  }

  /** Runs the given steps of one card in order, each with its own attempts (the third failure marks the card needs-review). */
  private async runCardJob(drive: Drive, nodeId: string, kinds: readonly PipelineStep[]): Promise<void> {
    drive.busy.add(nodeId);
    let base = 0;
    try {
      await drive.store.commit(state => ({ state: resetCard(state, nodeId), accepted: true }));
      base = cardRevision(drive.store.state, nodeId);
      for (const kind of kinds) {
        for (;;) {
          if (this.dead(drive) || drive.controller.signal.aborted || drive.fatal !== undefined) return;
          if (drive.store.state.status !== "running") return;
          if (attemptsOf(drive.store.state, nodeId)[kind] >= MAX_STEP_ATTEMPTS) {
            await this.markReview(drive, nodeId, kind, drive.reasons.get(nodeId) ?? "failed");
            return;
          }
          const action = { type: ACTION_OF[kind], nodeId } as const;
          const done = await this.step(drive, action);
          if (done === "ok") break;
          if (done !== "failed") return;
          // The third failure already marked the card (see step): nothing more to do for it.
          if (drive.stages.get(nodeId) === "needs-review") return;
        }
      }
    } finally {
      drive.busy.delete(nodeId);
      // Whatever changed this card's plan or text (even a rerun that stopped half way) makes its neighbours' joins worth a look.
      const revision = cardRevision(drive.store.state, nodeId);
      if (!this.dead(drive) && revision > base) await this.markSeams(drive, nodeId, revision);
    }
  }

  /**
   * The plan gate (gate 1 before the trial, every card planned): the root's `### 全書結構` is composed by the program from each card's
   * content headings and written into the plan callout (no AI call). Written again every time the run is back at the gate (back to plan,
   * a replan). A note that changed meanwhile or a drive that is over writes nothing: `structure_skipped` is logged, the gate shows anyway.
   */
  private async writeBookStructure(drive: Drive): Promise<void> {
    const signal = drive.controller.signal;
    if (this.dead(drive) || signal.aborted || drive.fatal !== undefined) return;
    try {
      const root = drive.cards.get(drive.rootId);
      const order = effectiveOrder(drive.store.state);
      const structure = this.structureOf(drive, order);
      if (!root) throw new Error("no root");
      const entries: StructureEntry[] = [];
      for (const id of order) {
        const info = drive.cards.get(id);
        const place = structure.placeOf(id);
        if (!info || !place) continue;
        const card = await this.ports.readCard(info.path);
        entries.push({
          kind: place.kind,
          ...(place.chapter === undefined ? {} : { chapter: place.chapter }),
          title: info.title,
          points: parseCardPoints(card.prompt) ?? []
        });
      }
      const before = await this.ports.readCard(root.path);
      const md = composeBookStructure(entries, drive.config.language);
      const next = replaceBookStructure(before.raw, md);
      if (next === before.raw) return;
      const written = await this.ports.updateNoteRawGuarded(root.path, () => next, {
        expectedContent: before.raw,
        authorize: () => !this.dead(drive) && !signal.aborted
      });
      if (written === "discarded") this.log(drive, "gate1", "-", "plan", "structure_skipped");
    } catch {
      this.log(drive, "gate1", "-", "plan", "structure_skipped");
    }
  }

  /**
   * After a single-chapter rerun: the left neighbour's `後一張` line and the right neighbour's `前一張` line are rewritten to the rerun
   * chapter's new "this chapter covers" sentence. Only that line of the Prompt changes (the chapter text, so its integrity fingerprint, is
   * not touched). A neighbour that is not on the map, whose text the reader edited by hand, or whose line already says it is left alone.
   */
  private async refreshNeighbourPlans(drive: Drive, nodeId: string): Promise<void> {
    const signal = drive.controller.signal;
    if (this.dead(drive) || signal.aborted || drive.fatal !== undefined) return;
    const order = effectiveOrder(drive.store.state);
    const at = order.indexOf(nodeId);
    const own = drive.cards.get(nodeId);
    if (at < 0 || !own) return;
    const structure = this.structureOf(drive, order);
    try {
      const card = await this.ports.readCard(own.path);
      const covers = summaryText(parseCardPrompt(card.prompt).covers ?? card.summary ?? "").trim();
      if (!covers) return;
      // The cards whose line describes this one: the previous chapter/section's `next` line and the next one's `previous` line.
      const around = structure.neighboursOf(nodeId);
      const sides = [
        { id: around.previous, key: "next" as const },
        { id: around.next, key: "previous" as const }
      ];
      for (const { id, key } of sides) {
        const info = id === undefined ? undefined : drive.cards.get(id);
        if (!info || this.dead(drive) || signal.aborted) continue;
        const raw = await this.ports.readCard(info.path);
        if (!isUntouched(raw.detail)) continue;
        const prompt = rewriteNeighbourLine(
          raw.prompt,
          key,
          { position: this.neighbourPosition(structure, id as string, nodeId), title: card.title, summary: covers },
          structure.placeOf(id as string)?.kind
        );
        if (prompt === undefined) continue;
        await this.ports.updateNoteGuarded(
          info.path,
          { prompt },
          { expectedContent: raw.raw, authorize: () => !this.dead(drive) && !signal.aborted }
        );
      }
    } catch {
      // a neighbour that cannot be read or written keeps its old line; the seam mark already tells the reader to look
    }
  }

  /** Chapters already planned that the program may not rewrite (hand-edited, unknown or kept, no permission): added to `planSkipped`, so a redo that never plans still refreshes them. */
  private async collectSkippedPlans(drive: Drive): Promise<void> {
    try {
      for (const nodeId of effectiveOrder(drive.store.state)) {
        const own = drive.cards.get(nodeId);
        if (!own || drive.stages.get(nodeId) === undefined) continue;
        if (!this.mayOverwriteCard(drive, nodeId, (await this.ports.readCard(own.path)).raw))
          drive.planSkipped.add(nodeId);
      }
    } catch {
      // a chapter that cannot be read is not refreshed
    }
  }

  /**
   * A chapter the plan step left alone keeps its old Prompt, so its `前一張` / `後一張` lines would still describe the neighbours of an
   * earlier order. After a plan step they are rewritten by the program from the current order (the Prompt is not under the chapter's
   * integrity fingerprint, so the reader's text and its state are untouched). A line that already says it, or a chapter without one, is left.
   */
  private async refreshSkippedPlans(drive: Drive): Promise<void> {
    const signal = drive.controller.signal;
    if (!drive.planSkipped.size || this.dead(drive) || signal.aborted || drive.fatal !== undefined) return;
    const order = effectiveOrder(drive.store.state);
    const structure = this.structureOf(drive, order);
    try {
      for (const nodeId of [...drive.planSkipped]) {
        const at = order.indexOf(nodeId);
        const own = drive.cards.get(nodeId);
        if (at < 0 || !own) continue;
        for (const { id: otherId, key } of this.neighbourSides(structure, nodeId)) {
          const other = otherId === undefined ? undefined : drive.cards.get(otherId);
          if (this.dead(drive) || signal.aborted) return;
          const raw = await this.ports.readCard(own.path);
          if (otherId !== undefined && !other) continue;
          let neighbourLine: NeighbourCard | null = null;
          if (other && otherId !== undefined) {
            const neighbour = await this.ports.readCard(other.path);
            neighbourLine = this.neighbourCardOf(structure, nodeId, otherId, key, neighbour);
          }
          const prompt = rewriteNeighbourLine(raw.prompt, key, neighbourLine, structure.placeOf(nodeId)?.kind);
          if (prompt === undefined) continue;
          await this.ports.updateNoteGuarded(
            own.path,
            { prompt },
            { expectedContent: raw.raw, authorize: () => !this.dead(drive) && !signal.aborted }
          );
        }
      }
    } catch {
      // a chapter that cannot be read or written keeps its old lines; the reader sees its hand-edit box anyway
    }
  }

  /**
   * After chapters were removed ("carry on as before"), the planned chapters' `前一張` / `後一張` lines may still name a removed chapter or
   * an old position. Each such line is pointed at the neighbour in the current order (its own sentence kept when only the position moved);
   * a line that already names it is left. Only those lines change: no role, stage, text or fingerprint is touched, and no AI call is made.
   */
  private async refreshAroundRemoved(drive: Drive): Promise<void> {
    const signal = drive.controller.signal;
    if (!drive.store.state.removed?.length || this.dead(drive) || signal.aborted || drive.fatal !== undefined) return;
    const order = effectiveOrder(drive.store.state);
    // The removed chapters' titles (a title a chapter of the book still has is not one).
    const present = new Set(order.map(id => drive.cards.get(id)?.title.trim() ?? ""));
    const gone = (drive.store.state.removed ?? [])
      .map(id => drive.store.state.chapters?.[id]?.title?.trim() ?? "")
      .filter(title => title && !present.has(title));
    const structure = this.structureOf(drive, order);
    try {
      for (const nodeId of order) {
        const own = drive.cards.get(nodeId);
        if (!own || drive.stages.get(nodeId) === undefined) continue;
        // The `接入點` line that still names a removed chapter goes (Primary decision: a join that is no longer there).
        const before = await this.ports.readCard(own.path);
        // The entry point also goes when the previous line named a removed chapter (the entry paraphrases it, not always by its exact title).
        const oldPrevious = neighbourLineTitle(before.prompt, "previous", structure.placeOf(nodeId)?.kind);
        const previousId = structure.neighboursOf(nodeId).previous;
        const previousGone =
          oldPrevious !== undefined &&
          gone.includes(oldPrevious) &&
          (previousId === undefined || drive.cards.get(previousId)?.title.trim() !== oldPrevious);
        const dropped = previousGone
          ? dropEntryLine(before.prompt)
          : gone.length
            ? dropEntryNaming(before.prompt, gone)
            : undefined;
        if (dropped !== undefined && !this.dead(drive) && !signal.aborted)
          await this.ports.updateNoteGuarded(
            own.path,
            { prompt: dropped },
            { expectedContent: before.raw, authorize: () => !this.dead(drive) && !signal.aborted }
          );
        // A section whose chapter was removed became a chapter: its old `所屬章` line goes.
        if (structure.placeOf(nodeId)?.kind !== "section") {
          const old = await this.ports.readCard(own.path);
          const withoutParent = dropParentLine(old.prompt);
          if (withoutParent !== undefined && !this.dead(drive) && !signal.aborted)
            await this.ports.updateNoteGuarded(
              own.path,
              { prompt: withoutParent },
              { expectedContent: old.raw, authorize: () => !this.dead(drive) && !signal.aborted }
            );
        }
        for (const { id: otherId, key } of this.neighbourSides(structure, nodeId)) {
          if (this.dead(drive) || signal.aborted) return;
          const other = otherId === undefined ? undefined : drive.cards.get(otherId);
          if (otherId !== undefined && !other) continue;
          const raw = await this.ports.readCard(own.path);
          let neighbourLine: NeighbourCard | null = null;
          if (other && otherId !== undefined) {
            const neighbour = await this.ports.readCard(other.path);
            neighbourLine = this.neighbourCardOf(structure, nodeId, otherId, key, neighbour);
          }
          const prompt = retargetNeighbourLine(raw.prompt, key, neighbourLine, structure.placeOf(nodeId)?.kind);
          if (prompt === undefined) continue;
          await this.ports.updateNoteGuarded(
            own.path,
            { prompt },
            { expectedContent: raw.raw, authorize: () => !this.dead(drive) && !signal.aborted }
          );
        }
      }
    } catch {
      // a chapter that cannot be read or written keeps its old lines
    }
  }

  private async markSeams(drive: Drive, nodeId: string, revision: number): Promise<void> {
    const order = effectiveOrder(drive.store.state);
    const at = order.indexOf(nodeId);
    for (const other of [order[at - 1], order[at + 1]]) {
      if (!other || !drive.cards.has(other)) continue;
      await this.writeFields(drive, other, { pipelineSeam: seamText(drive.config.language, at, revision) });
    }
    this.syncReviewNotes(drive);
  }

  /**
   * Aborts every call and pauses the run (resumable). Resolves when the drive is over. With no drive, `saved` (the owner's Stop
   * button) writes the stop into the saved state, so a budget pause or a state left "running" ends as a plain stop; refusals
   * (no run, finished, unreadable) leave the file as it is.
   */
  async stop(mapPath: string, options: { saved?: boolean } = {}): Promise<void> {
    const drive = this.drives.get(mapPath);
    if (!drive) {
      if (!options.saved) return;
      await this.enter(mapPath, async fresh => {
        await this.openSaved(fresh, mapPath);
        fresh.stopRequested = true;
      }).catch((error: unknown) => {
        if (!(error instanceof BookPipelineRunError)) throw error;
      });
      return;
    }
    drive.stopRequested = true;
    drive.controller.abort();
    await drive.done.catch(() => undefined);
  }

  /**
   * Applies the reader's notes of one chapter (one model call, one budget unit). A separate slot: it refuses while a drive holds the
   * map ("drive_running") or another notes job does ("notes_busy"), and a drive entry refuses ("busy") while it runs. It never changes
   * the book's phase or status (a stopped book stays stopped). Order: reservation check, backup (a failed one writes nothing and spends
   * nothing), the call, a re-check (same run, card still in order, not cancelled), then one writer transform. A late answer after a
   * cancel, a dispose or a replaced run is never written.
   */
  async applyNotes(mapPath: string, nodeId: string, options: { signal?: AbortSignal } = {}): Promise<NotesApplyResult> {
    if (this.disposed) throw new BookPipelineRunError("disposed");
    if (this.drives.has(mapPath)) throw new BookPipelineRunError("drive_running");
    if (this.notesJobs.has(mapPath)) throw new BookPipelineRunError("notes_busy");
    const job = new AbortController();
    this.notesJobs.set(mapPath, job);
    const onAbort = (): void => job.abort();
    if (options.signal?.aborted) job.abort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    const runId = { value: "-" };
    const line = (event: string, result: string, counts?: Record<string, number>): void =>
      this.ports.log(
        formatPipelineLog({
          event,
          runId: runId.value,
          card: nodeId,
          step: "write",
          attempt: 0,
          result,
          ms: Date.now() - started,
          ...(counts ? { counts } : {})
        })
      );
    try {
      const result = await this.runNotes(mapPath, nodeId, job, runId);
      line("notes_applied", "ok", { applied: result.applied, skipped: result.skipped });
      return result;
    } catch (error) {
      line("notes_failed", error instanceof BookPipelineRunError ? error.code : internalCode(error));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.notesJobs.delete(mapPath);
    }
  }

  private async runNotes(
    mapPath: string,
    nodeId: string,
    job: AbortController,
    runIdOut: { value: string }
  ): Promise<NotesApplyResult> {
    const signal = job.signal;
    const gone = (): boolean => signal.aborted || this.disposed;
    const refuseIfGone = (): void => {
      if (gone()) throw new BookPipelineRunError(this.disposed ? "disposed" : "cancelled");
    };
    const notes = this.ports.notes;
    if (!notes) throw new BookPipelineRunError("unreadable");
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind === "absent") throw new BookPipelineRunError("missing");
    if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
    const state = read.data;
    runIdOut.value = state.runId;
    const node = map.nodes.find(item => item.id === nodeId);
    if (!node || !effectiveOrder(state).includes(nodeId)) throw new BookPipelineRunError("missing");
    if (!reserveBudget(state.budget)) throw new BookPipelineRunError("budget");
    refuseIfGone();
    const path = node.path;
    let raw: string;
    try {
      raw = await notes.readText(path);
    } catch {
      throw new BookPipelineRunError("unreadable");
    }
    const items = snapshotNotes(raw);
    if (!items.length) throw new BookPipelineRunError("nothing");
    const sent = items.flatMap(item => (item.encoded ? [item.encoded] : [])).slice(0, MAX_NOTE_PARAGRAPHS);
    if (!sent.length) return { applied: 0, skipped: 0, marked: 0, edits: [] };
    // The copy comes first: when it fails nothing is spent and nothing is replaced.
    const saved = await this.ports.backupNote(path, raw).catch(() => ({ ok: false as const }));
    if (!saved.ok) throw new BookPipelineRunError("backup_failed");
    refuseIfGone();
    const rootNode = map.nodes.find(item => !item.parentId);
    const [card, root] = await Promise.all([
      this.ports.readCard(path),
      rootNode ? this.ports.readCard(rootNode.path) : undefined
    ]);
    const config = this.ports.config(mapPath);
    const request: ApplyNotesRequest = {
      language: config.language,
      model: config.authorModel,
      reasoning: config.reasoning,
      usageMapPath: mapPath,
      settings: effectiveSettings(root?.settings ?? {}, root ? parseBookPlanDecisions(root.raw) : {}),
      plan: card.prompt,
      items: sent
    };
    // One call is one unit, saved through the map guard before the provider is asked; nothing else of the saved state changes.
    const store = new PipelineStore(state, next =>
      this.ports.mutate(async () => {
        if (gone()) throw new BookPipelineRunError("cancelled");
        await this.ports.updateMap(mapPath, doc => {
          const found = readBookPipeline(doc);
          if (found.kind !== "usable" || found.data.runId !== state.runId) throw new BookPipelineRunError("stale");
          doc.bookPipeline = {
            ...found.data,
            budget: { used: Math.max(found.data.budget.used, next.budget.used), limit: found.data.budget.limit },
            revision: found.data.revision + 1
          };
        });
      })
    );
    const admission = createBudgetAdmission(createStoreBudgetPort(store));
    let replies: { id: string; text: string }[];
    let refused: { id: string; reason: string }[];
    try {
      const result = await untilAborted(signal, this.ports.runPlan(applyNotesStep, request, { signal, admission }));
      replies = result.paragraphs;
      refused = result.refused;
    } catch (error) {
      if (error instanceof BookPipelineRunError) throw error;
      if (isBudgetExhausted(error)) throw new BookPipelineRunError("budget");
      refuseIfGone();
      throw error;
    } finally {
      store.dispose();
    }
    // Re-check before the commit: same run, the card still in order and on the map, no cancel.
    refuseIfGone();
    const fresh = await this.ports.readMap(mapPath);
    const again = readBookPipeline(fresh);
    refuseIfGone();
    if (again.kind !== "usable" || again.data.runId !== state.runId || !effectiveOrder(again.data).includes(nodeId))
      throw new BookPipelineRunError("stale");
    if (fresh.nodes.find(item => item.id === nodeId)?.path !== path) throw new BookPipelineRunError("stale");
    let outcome: ApplyOutcome | undefined;
    const written = await notes.write(path, text => {
      // The last gate, inside the write: a cancel that came while the writer waited changes nothing.
      if (gone()) {
        outcome = undefined;
        return text;
      }
      outcome = applyReplies(
        text,
        items,
        replies,
        refused.map(r => r.id)
      );
      // The AI's rewrite is a program write: a chapter that was as the program left it keeps a matching fingerprint (a hand edit stays one).
      return programStampRaw(text, outcome.text);
    });
    // A cancel that arrives after the transform has written is too late to undo anything: the job finishes normally (undo record,
    // highlight, seams). Only a job that wrote nothing reports the cancel.
    if (!(written === "written" && outcome)) refuseIfGone();
    if (written === "refused") throw new BookPipelineRunError("stale");
    const done = written === "written" && outcome ? outcome : undefined;
    if (!done) return { applied: 0, skipped: 0, marked: 0, edits: [] };
    if (done.applied.length) await this.markNeighbourSeams(mapPath, again.data, nodeId, config.language, fresh);
    return { applied: done.applied.length, skipped: done.skipped, marked: done.marked, edits: done.applied, refused };
  }

  /** The body changed: both neighbours' joins are worth a look, as after a rerun. */
  private async markNeighbourSeams(
    mapPath: string,
    state: BookPipelineData,
    nodeId: string,
    language: string,
    map: MapDocument
  ): Promise<void> {
    const stateOrder = effectiveOrder(state);
    const at = stateOrder.indexOf(nodeId);
    // The card's revision and the map's own (every saved change of the run counts one, an applied notes job included): a second apply
    // writes a different line, so an accepted tick of a neighbour's mixed box no longer counts (plan §7-2).
    const revision = `${cardRevision(state, nodeId)}.${state.revision}`;
    for (const other of [stateOrder[at - 1], stateOrder[at + 1]]) {
      const path = other ? map.nodes.find(item => item.id === other)?.path : undefined;
      if (!path || this.disposed) continue;
      await this.ports
        .writePipelineFields(path, { pipelineSeam: seamText(language, at, revision) })
        .catch(() => undefined);
    }
    if (state.phase === "gate2" && this.ports.callouts && !this.disposed) {
      try {
        void Promise.resolve(this.ports.callouts.reconcile(mapPath)).catch(() => undefined);
      } catch {
        // a port that throws must not undo a written chapter
      }
    }
  }

  /** Plugin unload: abort everything; nothing is written afterwards. */
  dispose(): void {
    this.disposed = true;
    for (const job of this.notesJobs.values()) job.abort();
    for (const drive of this.drives.values()) {
      drive.disposed = true;
      drive.controller.abort();
      drive.store?.dispose();
    }
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  private dead(drive: Drive): boolean {
    return drive.disposed || this.disposed;
  }
  /**
   * `early`: the returned promise settles once `setup` succeeded (the run's new phase is written) or refused; the drive keeps running in
   * the background and its unexpected errors are handled by {@link go} (failure code, log), never as a rejection.
   */
  private enter(mapPath: string, setup: (drive: Drive) => Promise<void>, early = false): Promise<void> {
    if (this.disposed) return Promise.reject(new BookPipelineRunError("disposed"));
    if (this.drives.has(mapPath) || this.notesJobs.has(mapPath))
      return Promise.reject(new BookPipelineRunError("busy"));
    const drive = {
      mapPath,
      controller: new AbortController(),
      config: this.ports.config(mapPath),
      cards: new Map(),
      ownerRoles: new Set(),
      missingRoles: new Map(),
      stages: new Map(),
      backedUp: new Set(),
      backupPaths: new Map(),
      reasons: new Map(),
      fixIssues: new Map(),
      busy: new Set(),
      extra: new Map(),
      avoid: new Set(),
      fixable: new Map(),
      expand: new Set(),
      parents: new Map(),
      overwrite: new Map(),
      plans: new Map(),
      planSkipped: new Set(),
      ownSummary: new Set(),
      authorModels: new Map(),
      started: new Map(),
      durations: { plan: [], write: [] },
      sub: new Map(),
      imagesDone: new Set(),
      reviewStep: new Map(),
      stopRequested: false,
      disposed: false,
      rootId: "",
      usedImages: new Set<string>(),
      commonsBudget: { waited: 0, spent: false },
      usedWorks: new Map<string, string>(),
      probeGate: { active: 0, waiters: [] },
      done: Promise.resolve()
    } as unknown as Drive;
    this.drives.set(mapPath, drive);
    let ready: () => void = () => undefined;
    drive.done = this.go(drive, setup, () => ready());
    if (!early) return drive.done;
    return new Promise<void>((resolve, reject) => {
      ready = resolve;
      drive.done.then(resolve, reject);
    });
  }
  private async go(drive: Drive, setup: (drive: Drive) => Promise<void>, onSetup: () => void): Promise<void> {
    let refusal: BookPipelineRunError | undefined;
    try {
      await setup(drive);
      onSetup();
      if (drive.store && !this.dead(drive) && !drive.stopRequested) await (drive.job ? drive.job() : this.loop(drive));
    } catch (error) {
      if (error instanceof BookPipelineRunError) refusal = error;
      else if (!this.dead(drive)) {
        drive.fatal = error;
        drive.failure = internalCode(error);
        this.ports.log(
          formatPipelineLog({
            event: "error",
            runId: drive.store?.state.runId ?? "-",
            card: "-",
            step: "plan",
            attempt: 0,
            result: drive.failure,
            ms: 0
          })
        );
      }
    } finally {
      try {
        // A stop (or an unexpected error) is the run's last write: status "stopped", resumable. Never after dispose.
        if (drive.store && !this.dead(drive) && !drive.job) {
          // The owner's stop stays a plain stop; a run that ended by itself (whole-book plan failed, unexpected error) keeps its code.
          const code = drive.failure ?? (drive.fatal !== undefined ? "failed" : undefined);
          if (drive.stopRequested)
            await drive.store.commit(state => ({ state: stopRun(state), accepted: true })).catch(() => undefined);
          else if (code !== undefined)
            await drive.store.commit(state => ({ state: failRun(state, code), accepted: true })).catch(() => undefined);
        }
        if (drive.store) {
          this.last.set(drive.mapPath, this.progressOf(drive, false));
          drive.store.dispose();
        }
      } finally {
        this.drives.delete(drive.mapPath);
        // The toolbar shows the run's state (gate 1's question, a finished round): redraw it now the drive is no longer running.
        if (!this.disposed)
          try {
            this.ports.progressed?.(drive.mapPath);
          } catch {
            // a failed repaint never keeps the drive's end (the busy slot, the settled hook) from finishing
          }
        // A drive is over: a rewrite the reader queued behind it may run now (it checks the phase itself).
        if (!this.disposed) this.ports.settled?.(drive.mapPath);
      }
    }
    if (refusal) throw refusal;
  }

  /** The book's structure of `order` (the cards the run works on) from the parents as the drive loaded them. */
  private structureOf(drive: Drive, order: readonly string[]): BookStructure {
    return bookStructure(order, id => drive.parents.get(id), drive.rootId);
  }
  /** What a neighbour line says of `otherId` on the line of `ownId`: a chapter number (`"preface"` for the root), none beside a section. */
  private neighbourPosition(structure: BookStructure, ownId: string, otherId: string): number | "preface" | undefined {
    if (structure.placeOf(ownId)?.kind === "section") return undefined;
    const place = structure.placeOf(otherId);
    return place?.kind === "preface" ? "preface" : place?.chapter;
  }
  /** The lines of a card's Prompt that name another card, with the card each names now (`undefined` = none): a section's chapter, the previous and the next. */
  private neighbourSides(
    structure: BookStructure,
    ownId: string
  ): { id: string | undefined; key: "parent" | "previous" | "next" }[] {
    const around = structure.neighboursOf(ownId);
    return [
      ...(structure.placeOf(ownId)?.kind === "section" ? [{ id: around.parent, key: "parent" as const }] : []),
      { id: around.previous, key: "previous" as const },
      { id: around.next, key: "next" as const }
    ];
  }
  /** What the line `key` of `ownId` says of `otherId` (a section's chapter line has the chapter number and no sentence). */
  private neighbourCardOf(
    structure: BookStructure,
    ownId: string,
    otherId: string,
    key: "parent" | "previous" | "next",
    neighbour: PipelineCard
  ): NeighbourCard {
    return {
      position:
        key === "parent" ? structure.placeOf(otherId)?.chapter : this.neighbourPosition(structure, ownId, otherId),
      title: neighbour.title,
      summary:
        key === "parent" ? "" : summaryText(parseCardPrompt(neighbour.prompt).covers ?? neighbour.summary ?? "").trim()
    };
  }
  /** A card's place as the plan steps write it (`preface`, `chapter 2`, `section 1 of 3 in chapter 2`). */
  private placeOf(drive: Drive, structure: BookStructure, id: string): string {
    return placeText(this.planPlaceOf(drive, structure, id));
  }
  private planPlaceOf(drive: Drive, structure: BookStructure, id: string): CardPlanPlace {
    const place = structure.placeOf(id);
    if (!place || place.kind === "preface") return { kind: "preface" };
    if (place.kind === "chapter") return { kind: "chapter", chapter: place.chapter };
    return {
      kind: "section",
      chapter: structure.placeOf(place.chapterId as string)?.chapter,
      sectionIndex: place.sectionIndex,
      sectionCount: place.sectionCount
    };
  }
  private orderOf(map: MapDocument): string[] {
    const roots = map.nodes.filter(node => !node.parentId);
    if (roots.length !== 1) throw new BookPipelineRunError("root");
    const order = bookReadingOrder(map);
    // A root alone has no chapter to write.
    if (order.length < 2) throw new BookPipelineRunError("empty");
    return order;
  }
  private attachStore(drive: Drive, state: BookPipelineData): void {
    drive.syncKey = `${state.phase}:${state.status}`;
    drive.store = new PipelineStore(state, next => this.persist(drive, next));
    drive.admission = createBudgetAdmission(createStoreBudgetPort(drive.store));
  }
  /** The state goes to the map file through the plugin's write queue (never from inside a `mutate` callback). */
  private persist(drive: Drive, state: BookPipelineData): Promise<void> {
    return this.ports.mutate(async () => {
      if (this.dead(drive) || drive.store.isDisposed) return;
      await this.ports.updateMap(drive.mapPath, doc => {
        doc.bookPipeline = state;
      });
      // A new phase or a stop/resume changes what the chapter notes should say (the trial hint, the review box).
      const key = `${state.phase}:${state.status}`;
      if (drive.syncKey !== undefined && drive.syncKey !== key) this.syncNotes(drive);
      drive.syncKey = key;
    });
  }
  /** Asks the notes to follow the run (fire and forget: the port logs its own failures; nothing here waits for a note write). */
  private syncNotes(drive: Drive): void {
    if (this.dead(drive) || !this.ports.callouts) return;
    try {
      void Promise.resolve(this.ports.callouts.reconcile(drive.mapPath)).catch(() => undefined);
    } catch {
      // a port that throws must not stop the run
    }
  }
  /** A card's result changed at gate 2 or after the run finished (a failure, a rerun): its AI proofread box is written, rewritten or taken off. */
  private syncReviewNotes(drive: Drive): void {
    const phase = drive.store?.state.phase;
    if (phase === "gate2" || phase === "done") this.syncNotes(drive);
  }
  /** Reads the saved state of a map for resume and gate confirmation, and loads the cards. */
  private async openSaved(
    drive: Drive,
    mapPath: string,
    options: { allowDone?: boolean } = {}
  ): Promise<BookPipelineData> {
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    const read = readBookPipeline(map);
    if (read.kind === "absent") throw new BookPipelineRunError("missing");
    if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
    // A finished run is closed, except for a single-card rerun and for the budget pause such a rerun can end in.
    if (
      read.data.phase === "done" &&
      !options.allowDone &&
      !(read.data.status === "stopped" && read.data.pauseReason === "budget")
    )
      throw new BookPipelineRunError("finished");
    await this.load(drive, map, effectiveOrder(read.data), new Set(read.data.autoRoles));
    if (this.dead(drive)) throw new BookPipelineRunError("disposed");
    this.attachStore(drive, read.data);
    return read.data;
  }
  /** Reads every card of the run: its path, title, summary, role and stage (kept in memory, updated after each write). */
  private async load(
    drive: Drive,
    map: MapDocument,
    order: readonly string[],
    autoRoles: ReadonlySet<string>
  ): Promise<void> {
    drive.rootId = map.nodes.find(node => !node.parentId)?.id ?? "";
    if (map.nodes.filter(node => !node.parentId).length !== 1) throw new BookPipelineRunError("root");
    drive.ownerRoles.clear();
    drive.missingRoles.clear();
    drive.parents = new Map(map.nodes.map(node => [node.id, node.parentId]));
    for (const id of order) {
      const node = map.nodes.find(item => item.id === id);
      if (!node) {
        drive.stages.set(id, undefined);
        continue;
      }
      try {
        const card = await this.ports.readCard(node.path);
        if (card.fields.bookRole) {
          // Order: the recorded `book-role-by`, then a pipeline-role difference (a hand edit, recorded as the owner's), then the older id list.
          const f = card.fields;
          const byHand = !!f.pipelineRole && f.bookRole !== f.pipelineRole;
          const owner =
            f.bookRoleBy === "owner" || byHand
              ? true
              : f.bookRoleBy === "ai"
                ? false
                : f.pipelineRole
                  ? false
                  : !autoRoles.has(id);
          if (owner) {
            drive.ownerRoles.add(id);
            if (f.bookRoleBy !== "owner" && byHand)
              await this.ports.writePipelineFields(node.path, { bookRoleBy: "owner" }).catch(() => undefined);
          }
        } else drive.missingRoles.set(id, !node.parentId || node.parentId === drive.rootId ? "intro" : "body");
        drive.cards.set(id, {
          path: node.path,
          title: card.title,
          summary: card.summary,
          role: card.fields.bookRole ?? drive.missingRoles.get(id) ?? "body"
        });
        drive.stages.set(id, card.fields.pipelineStage);
      } catch {
        throw new BookPipelineRunError("unreadable");
      }
    }
  }

  // ---- the loop ----------------------------------------------------------------------------------------------------------------
  private stagesOf(drive: Drive): Record<string, PipelineStage | undefined> {
    return Object.fromEntries(drive.stages);
  }
  private async loop(drive: Drive): Promise<void> {
    const inflight = new Map<string, Promise<void>>();
    while (!this.dead(drive) && drive.fatal === undefined) {
      // Before each step: the map's cards against the accepted set. A difference pauses the run (nothing new is admitted).
      if (await this.pauseOnMapChange(drive)) {
        drive.skippedRefreshed = false;
        break;
      }
      if (!drive.skippedRefreshed) {
        drive.skippedRefreshed = true;
        await this.collectSkippedPlans(drive);
        await this.refreshSkippedPlans(drive);
        await this.refreshAroundRemoved(drive);
      }
      const plan = nextActions(drive.store.state, this.stagesOf(drive), drive.busy, {
        aiProof: !!this.ports.aiProof && !!this.ports.aiFix && !!this.ports.aiBookProof && !drive.job
      });
      if (plan.hold === "global_failed") drive.failure = drive.reasons.get("global") ?? "failed";
      if (plan.hold === "gate1" && drive.store.state.planReview) await this.writeBookStructure(drive);
      if (plan.hold) break;
      let started = 0;
      let changed = false;
      for (const action of plan.actions) {
        if (this.dead(drive) || drive.controller.signal.aborted) break;
        if (action.type === "reset_stage") {
          await this.reset(drive, action.nodeId);
          changed = true;
        } else if (action.type === "mark_needs_review") {
          await this.markReview(drive, action.nodeId, action.step, drive.reasons.get(action.nodeId) ?? "failed");
          changed = true;
        } else if (action.type === "advance_phase") {
          if (await this.startFixes(drive)) {
            changed = true;
            continue;
          }
          const before = drive.store.state;
          // The book is done only once its closing page is written (a failed write is retried once, then the run stops).
          if (before.phase === "gate2" && this.ports.writeOpenIssues && !(await this.writeClosingPage(drive))) {
            if (!this.dead(drive))
              await drive.store.commit(state => ({ state: failRun(state, "open_issues_write"), accepted: true }));
            changed = true;
            continue;
          }
          await drive.store.commit(state => ({
            state: advancePhase(state, this.stagesOf(drive), this.ports.now()),
            accepted: true
          }));
          if (drive.store.state !== before) changed = true;
        } else if (action.type === "ai_proof" || action.type === "ai_fix") {
          if (inflight.size >= BOOK_POOL) continue;
          const key = action.nodeId;
          drive.busy.add(key);
          started++;
          inflight.set(
            key,
            this.aiChapter(drive, key, action.type === "ai_fix" ? "fix" : "proof").finally(() => {
              drive.busy.delete(key);
              inflight.delete(key);
            })
          );
        } else if (action.type === "book_ai_proof" || action.type === "book_ai_fix") {
          // The automatic redos go first: the proofread reads the chapters as they end up.
          if (await this.startFixes(drive)) {
            changed = true;
            continue;
          }
          drive.busy.add(BOOK_PROOF_BUSY);
          started++;
          inflight.set(
            BOOK_PROOF_BUSY,
            this.aiBook(drive, action.type === "book_ai_fix" ? "fix" : "proof").finally(() => {
              drive.busy.delete(BOOK_PROOF_BUSY);
              inflight.delete(BOOK_PROOF_BUSY);
            })
          );
        } else {
          const key = action.type === "global_plan" ? "global" : action.nodeId;
          if (action.type !== "global_plan" && inflight.size >= BOOK_POOL) continue;
          drive.busy.add(key);
          started++;
          inflight.set(
            key,
            this.step(drive, action)
              .then(() => undefined)
              .finally(() => {
                drive.busy.delete(key);
                inflight.delete(key);
              })
          );
        }
      }
      if (changed && !started) continue;
      if (inflight.size) await Promise.race(inflight.values());
      else if (!started && !changed) break;
    }
    await Promise.all(inflight.values());
  }

  /** The map's cards in reading order (every card, hidden ones too). */
  private mapIds(map: MapDocument): string[] {
    return bookReadingOrder(map);
  }
  /**
   * The map's cards differ from the accepted set: the run is saved as paused first (so nothing new is admitted and every result still
   * in flight is dropped at its commit), the calls in flight are aborted (the caller waits for them to settle; the busy slot is freed
   * when the drive ends), and the program callouts of the missing chapters are taken off. Returns whether it paused.
   */
  private async pauseOnMapChange(drive: Drive): Promise<boolean> {
    if (drive.job || this.dead(drive) || drive.store.state.status !== "running") return false;
    const map = await this.ports.readMap(drive.mapPath);
    if (this.dead(drive)) return false;
    const change = mapDifference(drive.store.state, this.mapIds(map));
    if (!change.added.length && !change.missing.length) return false;
    await drive.store.commit(state => ({ state: pauseForMap(state, change), accepted: true }));
    drive.controller.abort();
    const state = drive.store.state;
    const gone = change.missing.flatMap(id => {
      // A card already missing when this drive opened was never loaded: the snapshot taken at start or replan knows its note.
      const path = drive.cards.get(id)?.path ?? state.chapters?.[id]?.path;
      return path ? [{ id, path }] : [];
    });
    if (gone.length && this.ports.callouts?.clearNotes)
      await this.ports.callouts.clearNotes(drive.mapPath, state.runId, gone).catch(() => false);
    this.log(drive, "map_changed", "-", "plan", `added:${change.added.length},missing:${change.missing.length}`);
    return true;
  }
  /** True when the map's cards differ from the accepted set (a step that found its card gone asks this before it counts as a failure). */
  private async mapDiffers(drive: Drive): Promise<boolean> {
    const map = await this.ports.readMap(drive.mapPath);
    const change = mapDifference(drive.store.state, this.mapIds(map));
    return change.added.length > 0 || change.missing.length > 0;
  }
  /**
   * "Carry on as before": the new cards are left out, the missing chapters are marked removed (terminal), the map's card set becomes the
   * accepted one and the run goes on. Only for a run paused because the map changed.
   */
  async keepBookMap(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath);
      if (data.status !== "stopped" || data.pauseReason !== "map") throw new BookPipelineRunError("not_stopped");
      const ids = this.mapIds(await this.ports.readMap(mapPath));
      await drive.store.commit(state => ({
        state: acceptMapChange(state, ids, this.ports.now(), left => this.structureOf(drive, left).trialOf()),
        accepted: true
      }));
      this.log(drive, "map_keep", "-", "plan", "ok");
    });
  }

  // ---- one step ----------------------------------------------------------------------------------------------------------------
  private async step(
    drive: Drive,
    action: Extract<PipelineAction, { type: "global_plan" | "card_plan" | "card_write" | "card_proof" }>
  ): Promise<StepResult> {
    try {
      return await this.stepOnce(drive, action);
    } finally {
      // The in-memory sub-step ends with the step, whatever way it ended.
      drive.sub.delete(action.type === "global_plan" ? "global" : action.nodeId);
    }
  }
  private async stepOnce(
    drive: Drive,
    action: Extract<PipelineAction, { type: "global_plan" | "card_plan" | "card_write" | "card_proof" }>
  ): Promise<StepResult> {
    const nodeId = action.type === "global_plan" ? undefined : action.nodeId;
    const kind = action.type === "global_plan" ? "global" : STEP_OF[action.type];
    const key = nodeId ?? "global";
    const logStep: PipelineStep = kind === "global" ? "plan" : kind;
    const startedAt = Date.parse(this.ports.now());
    if (nodeId && !drive.started.has(nodeId)) drive.started.set(nodeId, startedAt);
    drive.sub.set(key, { step: logStep, startedAt });
    try {
      const begun = await drive.store.commit(state => {
        const dispatched = beginStep(state, kind, nodeId);
        return dispatched
          ? { state: dispatched.state, accepted: true, token: dispatched.token }
          : { state, accepted: false as const, token: undefined };
      });
      if (!begun || !begun.accepted || !begun.token) return "none";
      const token = begun.token;
      let outcome: Outcome;
      try {
        outcome =
          action.type === "global_plan"
            ? await this.execGlobal(drive, token)
            : action.type === "card_plan"
              ? await this.execPlan(drive, token, action.nodeId)
              : action.type === "card_write"
                ? await this.execWrite(drive, token, action.nodeId)
                : await this.execProof(drive, token, action.nodeId);
      } catch (error) {
        outcome = this.classify(drive, error);
      }
      if (this.dead(drive)) return "none";
      const ms = Math.max(0, Date.parse(this.ports.now()) - startedAt || 0);
      const report = async (result: string): Promise<void> => {
        const attempt = attemptsOf(drive.store.state, key)[logStep];
        this.ports.log(
          formatPipelineLog({ event: "step", runId: token.runId, card: key, step: logStep, attempt, result, ms })
        );
      };
      if (outcome.kind === "ok") {
        const done = await drive.store.commit(state => applySuccess(state, token));
        if (!done) return "none";
        if (!done.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return "dropped";
        }
        await outcome.after?.();
        if (action.type === "card_plan") await this.refreshSkippedPlans(drive);
        this.recordDuration(drive, kind, nodeId, Date.parse(this.ports.now()), drive.store.state.phase);
        await report("ok");
        return "ok";
      } else if (outcome.kind === "cancelled") {
        await drive.store.commit(state => applyCancelled(state, token));
        await report("cancelled");
        return "cancelled";
      } else if (outcome.kind === "budget") {
        await drive.store.commit(state => applyBudgetExhausted(state, token));
        drive.controller.abort();
        await report("budget");
        return "budget";
      } else {
        // A card that left the map is not a failure: it is never retried and costs no attempt; the loop pauses on the map change.
        if ((outcome.reason === "card_removed" || outcome.reason === "missing") && (await this.mapDiffers(drive))) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("map_changed");
          return "cancelled";
        }
        const failed = await drive.store.commit(state => applyFailure(state, token));
        if (!failed) return "none";
        if (!failed.accepted) {
          await drive.store.commit(state => applyCancelled(state, token));
          await report("dropped");
          return "dropped";
        }
        drive.reasons.set(key, outcome.reason);
        if (nodeId && kind !== "global" && (failed.needsReview || outcome.forceReview))
          await this.markReview(drive, nodeId, kind, outcome.reason);
        await report(`failed:${code(outcome.reason)}`);
        return "failed";
      }
    } catch (error) {
      if (!this.dead(drive)) {
        drive.fatal = error;
        drive.failure = internalCode(error);
        this.ports.log(
          formatPipelineLog({
            event: "error",
            runId: drive.store?.state.runId ?? "-",
            card: key,
            step: logStep,
            attempt: 0,
            result: drive.failure,
            ms: 0
          })
        );
      }
    }
    return "none";
  }

  /**
   * One step of a chapter's independent AI proofread: the check (the proof model, web search) or the fix (the author model, edits
   * applied by the program). The attempt is counted before the call and saved; a stop or a text changed meanwhile drops the result.
   */
  private async aiChapter(drive: Drive, nodeId: string, want: "proof" | "fix", rerun = false): Promise<void> {
    const info = drive.cards.get(nodeId);
    if (!info || !this.ports.aiProof || !this.ports.aiFix) return;
    const signal = drive.controller.signal;
    const card = await this.ports.readCard(info.path).catch(() => undefined);
    if (this.dead(drive)) return;
    const giveUp = async (): Promise<void> => {
      await drive.store.commit(state =>
        state.status === "running" &&
        effectiveOrder(state).includes(nodeId) &&
        (rerun ? !state.aiProof?.[nodeId]?.done : aiChapterDue(state, nodeId))
          ? { state: abandonAi(state, nodeId), accepted: true }
          : { state, accepted: false }
      );
    };
    if (!card) return giveUp();
    const body = aiProofBody(chapterBody(card.detail));
    const revision = cardRevision(drive.store.state, nodeId);
    const key = aiProofKey(revision, body);
    const stored = drive.store.state.aiProof?.[nodeId];
    const same = stored?.key === key ? stored : undefined;
    const step = same ? want : "proof";
    const begun = await drive.store.commit(state => {
      const dispatched = beginAiStep(state, { nodeId, ...(rerun ? { rerun } : {}) }, key, step);
      return dispatched
        ? { state: dispatched.state, accepted: true, token: dispatched.token }
        : { state, accepted: false as const, token: undefined };
    });
    if (!begun?.accepted || !begun.token) return giveUp();
    const token = begun.token;
    if (!body.trim()) {
      // No chapter text: nothing to check and nothing to ask the model (the chapter's own state already lists it).
      await drive.store.commit(state => applyAiProof(state, token, { checked: 0, pending: [], open: [] }));
      return;
    }
    const startedAt = Date.parse(this.ports.now());
    const report = (result: string, counts: Record<string, number> = {}): void => {
      const attempt = drive.store.state.aiProof?.[nodeId]?.attempts ?? 0;
      const ms = Math.max(0, Date.parse(this.ports.now()) - startedAt || 0);
      this.ports.log(
        formatPipelineLog({
          event: step === "fix" ? "ai_fix" : "ai_proof",
          runId: token.runId,
          card: nodeId,
          step: "proof",
          attempt,
          result,
          ms,
          counts
        })
      );
    };
    const run = { signal, admission: drive.admission };
    try {
      if (step === "proof") {
        const prior = priorOf(same?.pending ?? []);
        const review = await untilAborted(
          signal,
          this.ports.aiProof(
            {
              ...this.base(drive, drive.config.proofModel),
              title: card.title,
              body,
              sources: chapterSources(card.detail),
              ...(prior.length ? { prior } : {})
            },
            run
          )
        );
        if (this.dead(drive)) return;
        const pending = fixTargetsOf(review.checks);
        const open = review.checks
          .filter(check => checkState(check) === "unfixable")
          .map(check => ({
            id: check.id,
            ...(check.chapter ? { chapter: check.chapter } : {}),
            quote: check.quote,
            problem: check.problem,
            reason: check.why ?? "unfixable"
          }));
        const done = await drive.store.commit(state =>
          applyAiProof(state, token, { checked: review.checks.length, pending, open })
        );
        if (!done?.accepted) {
          await drive.store.commit(state => applyAiStopped(state, token, false));
          return report("dropped");
        }
        return report("ok", { checked: review.checks.length, pending: pending.length, open: open.length });
      }
      const targets = same?.pending ?? [];
      const raw = card.raw;
      const state = bodyStateRaw(raw);
      if ((state !== "clean" && state !== "empty") || isKeptRaw(raw)) {
        // The reader's own text (hand-edited, unknown or kept): no call, nothing is rewritten, every problem is left open.
        const refused = Object.fromEntries(targets.map(target => [target.id, "hand_edited"]));
        const done = await drive.store.commit(current => applyAiFix(current, token, { applied: 0, appliedIds: [], refused }));
        return report(done?.accepted ? "ok" : "dropped", { applied: 0, pending: targets.length });
      }
      const rootInfo = drive.cards.get(drive.rootId);
      const root = rootInfo ? await this.ports.readCard(rootInfo.path).catch(() => undefined) : undefined;
      const range = root
        ? lengthRange(effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)).length)
        : undefined;
      const edits = await untilAborted(
        signal,
        this.ports.aiFix(
          {
            ...this.base(drive, drive.config.authorModel),
            chapters: [{ number: 1, title: card.title, text: body }],
            targets
          },
          run
        )
      );
      if (this.dead(drive)) return;
      const result = applyAiEdits(detailBlockOf(raw) ?? "", targets, edits, {
        shown: body,
        ...(range ? { length: { unit: range.unit, min: range.min } } : {})
      });
      const refused = refusedReasons(result.outcomes);
      let newKey: string | undefined;
      if (result.applied > 0) {
        const path = await this.stillOnMap(drive, nodeId);
        if (!path) throw new Error("card_removed");
        if (!(await this.ensureBackup(drive, nodeId, path, raw))) throw new Error("backup_failed");
        const next = programStampRaw(raw, replaceDetailBlock(raw, result.text));
        const written = await this.ports.updateNoteRawGuarded(path, () => next, {
          expectedContent: raw,
          authorize: () => !this.dead(drive) && !signal.aborted && isAiCurrent(drive.store.state, token)
        });
        if (written === "discarded") {
          await drive.store.commit(current => applyAiStopped(current, token, false));
          return report("dropped");
        }
        const after = await this.ports.readCard(path).catch(() => undefined);
        newKey = aiProofKey(token.revision + 1, aiProofBody(chapterBody(after?.detail ?? card.detail)));
      }
      const done = await drive.store.commit(current =>
        applyAiFix(current, token, {
          applied: result.applied,
          appliedIds: appliedIdsOf(result.outcomes),
          refused,
          ...(newKey ? { key: newKey, changed: [nodeId] } : {})
        })
      );
      report(done?.accepted ? "ok" : "dropped", { applied: result.applied, pending: targets.length });
    } catch (error) {
      if (this.dead(drive)) return;
      const outcome = this.classify(drive, error);
      if (outcome.kind === "budget" || outcome.kind === "cancelled") {
        await drive.store.commit(current => applyAiStopped(current, token, outcome.kind === "budget"));
        if (outcome.kind === "budget") drive.controller.abort();
        return report(outcome.kind);
      }
      await drive.store.commit(current => applyAiFailure(current, token));
      report(`failed:${code(outcome.kind === "failed" ? outcome.reason : "failed")}`);
    }
  }
  /** The chapters with text in reading order, as the whole-book proofread reads them (prose only), with the program's own findings as hints. */
  private async bookProofInput(drive: Drive): Promise<{
    chapters: { id: string; title: string; text: string; raw: string }[];
    hints: string[];
  }> {
    const ordered: (ReferenceChapter & { raw: string })[] = [];
    const structure = this.structureOf(drive, effectiveOrder(drive.store.state));
    for (const id of effectiveOrder(drive.store.state)) {
      const info = drive.cards.get(id);
      if (!info) continue;
      const card = await this.ports.readCard(info.path).catch(() => undefined);
      const place = structure.placeOf(id);
      const chapter =
        place?.kind === "chapter"
          ? place.chapter
          : place?.chapterId
            ? structure.placeOf(place.chapterId)?.chapter
            : undefined;
      ordered.push({
        id,
        title: card?.title ?? info.title,
        text: card ? aiProofBody(chapterBody(card.detail)) : "",
        raw: card?.raw ?? "",
        ...(chapter !== undefined ? { chapter } : {}),
        ...(place?.kind === "section" ? { section: true as const } : {})
      });
    }
    const chapters = ordered.filter(chapter => chapter.text);
    const number = (id: string): string => {
      const at = chapters.findIndex(chapter => chapter.id === id);
      return at < 0 ? "?" : String(at + 1);
    };
    const findings = [
      ...chapterReferenceFindings(ordered),
      ...directionFindings(ordered),
      ...numericFindings(chapters, []),
      ...removedChapterRefs(drive.store.state, chapters)
    ];
    const hints = findings.map(
      finding =>
        `chapter ${number(finding.a)}: "${finding.claimA}"; ${
          finding.kind === "removed" ? "names a removed chapter" : `chapter ${number(finding.b)}`
        }: "${finding.claimB}"${finding.suggestion ? ` (${finding.suggestion})` : ""}`
    );
    return { chapters, hints };
  }

  /**
   * One step of the whole-book AI proofread: the check (the proof model, text only, over every chapter) or the fix (the author model; the
   * edits are applied chapter by chapter, each chapter written once). Same fences as {@link aiChapter}.
   */
  private async aiBook(drive: Drive, want: "proof" | "fix"): Promise<void> {
    if (!this.ports.aiBookProof || !this.ports.aiFix) return;
    const signal = drive.controller.signal;
    const input = await this.bookProofInput(drive).catch(() => undefined);
    if (this.dead(drive)) return;
    const giveUp = async (): Promise<void> => {
      await drive.store.commit(state =>
        state.status === "running" ? { state: abandonAi(state), accepted: true } : { state, accepted: false }
      );
    };
    if (!input) return giveUp();
    const { chapters, hints } = input;
    const joined = (texts: readonly string[]): string => texts.join("\n\u0000\n");
    const key = aiProofKey(0, joined(chapters.map(chapter => chapter.text)));
    const stored = drive.store.state.bookProof;
    const same = stored?.key === key ? stored : undefined;
    const step = same ? want : "proof";
    const begun = await drive.store.commit(state => {
      const dispatched = beginAiStep(state, {}, key, step);
      return dispatched
        ? { state: dispatched.state, accepted: true, token: dispatched.token }
        : { state, accepted: false as const, token: undefined };
    });
    if (!begun?.accepted || !begun.token) return giveUp();
    const token = begun.token;
    const startedAt = Date.parse(this.ports.now());
    const report = (result: string, counts: Record<string, number> = {}): void => {
      const attempt = drive.store.state.bookProof?.attempts ?? 0;
      const ms = Math.max(0, Date.parse(this.ports.now()) - startedAt || 0);
      this.ports.log(
        formatPipelineLog({
          event: step === "fix" ? "ai_fix" : "ai_proof",
          runId: token.runId,
          card: "book",
          step: "proof",
          attempt,
          result,
          ms,
          counts
        })
      );
    };
    const run = { signal, admission: drive.admission };
    try {
      if (step === "proof") {
        const prior = priorOf(same?.pending ?? []);
        const review = await untilAborted(
          signal,
          this.ports.aiBookProof(
            {
              ...this.base(drive, drive.config.proofModel),
              chapters: compactChapters(chapters.map(chapter => ({ title: chapter.title, text: chapter.text }))),
              hints,
              ...(prior.length ? { prior } : {})
            },
            run
          )
        );
        if (this.dead(drive)) return;
        const pending = fixTargetsOf(review.checks);
        const open = review.checks
          .filter(check => checkState(check) === "unfixable")
          .map(check => ({
            id: check.id,
            ...(check.chapter ? { chapter: check.chapter } : {}),
            quote: check.quote,
            problem: check.problem,
            reason: check.why ?? "unfixable"
          }));
        const done = await drive.store.commit(state =>
          applyAiProof(state, token, { checked: review.checks.length, pending, open })
        );
        if (!done?.accepted) {
          await drive.store.commit(state => applyAiStopped(state, token, false));
          return report("dropped");
        }
        return report("ok", { checked: review.checks.length, pending: pending.length, open: open.length });
      }
      const targets = same?.pending ?? [];
      const rootInfo = drive.cards.get(drive.rootId);
      const root = rootInfo ? await this.ports.readCard(rootInfo.path).catch(() => undefined) : undefined;
      const range = root
        ? lengthRange(effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)).length)
        : undefined;
      const edits = await untilAborted(
        signal,
        this.ports.aiFix(
          {
            ...this.base(drive, drive.config.authorModel),
            chapters: chapters.map((chapter, at) => ({ number: at + 1, title: chapter.title, text: chapter.text })),
            targets
          },
          run
        )
      );
      if (this.dead(drive)) return;
      const refused: Record<string, AiFixRefusal> = {};
      const changed: string[] = [];
      const appliedIds: string[] = [];
      let applied = 0;
      let discarded = false;
      const owner = new Map(targets.map(target => [target.id, target.chapter ?? 1]));
      for (let at = 0; at < chapters.length; at++) {
        const mine = targets.filter(target => (target.chapter ?? 1) === at + 1);
        if (!mine.length) continue;
        const chapter = chapters[at];
        const state = bodyStateRaw(chapter.raw);
        if ((state !== "clean" && state !== "empty") || isKeptRaw(chapter.raw)) {
          for (const target of mine) refused[target.id] = "hand_edited";
          continue;
        }
        const own = edits.filter(edit => owner.get(edit.id) === at + 1);
        const result = applyAiEdits(detailBlockOf(chapter.raw) ?? "", mine, own, {
          shown: chapter.text,
          ...(range ? { length: { unit: range.unit, min: range.min } } : {})
        });
        Object.assign(refused, refusedReasons(result.outcomes));
        if (result.applied === 0) continue;
        const path = await this.stillOnMap(drive, chapter.id);
        if (!path) throw new Error("card_removed");
        if (!(await this.ensureBackup(drive, chapter.id, path, chapter.raw))) throw new Error("backup_failed");
        const next = programStampRaw(chapter.raw, replaceDetailBlock(chapter.raw, result.text));
        const written = await this.ports.updateNoteRawGuarded(path, () => next, {
          expectedContent: chapter.raw,
          authorize: () => !this.dead(drive) && !signal.aborted && isAiCurrent(drive.store.state, token)
        });
        if (written === "discarded") {
          // Chapters written before this one are real: they are recorded (the fix round is spent) instead of being forgotten.
          if (!changed.length) {
            await drive.store.commit(current => applyAiStopped(current, token, false));
            return report("dropped");
          }
          discarded = true;
          break;
        }
        applied += result.applied;
        appliedIds.push(...appliedIdsOf(result.outcomes));
        changed.push(chapter.id);
      }
      let newKey: string | undefined;
      if (changed.length) {
        const after = await this.bookProofInput(drive);
        newKey = aiProofKey(0, joined(after.chapters.map(chapter => chapter.text)));
      }
      const done = await drive.store.commit(current =>
        applyAiFix(current, token, { applied, appliedIds, refused, ...(newKey ? { key: newKey, changed } : {}) })
      );
      if (discarded) return report("dropped", { applied, pending: targets.length });
      report(done?.accepted ? "ok" : "dropped", { applied, pending: targets.length });
    } catch (error) {
      if (this.dead(drive)) return;
      const outcome = this.classify(drive, error);
      if (outcome.kind === "budget" || outcome.kind === "cancelled") {
        await drive.store.commit(current => applyAiStopped(current, token, outcome.kind === "budget"));
        if (outcome.kind === "budget") drive.controller.abort();
        return report(outcome.kind);
      }
      await drive.store.commit(current => applyAiFailure(current, token));
      report(`failed:${code(outcome.kind === "failed" ? outcome.reason : "failed")}`);
    }
  }
  /** The issues of the closing page, as items: open AI findings, an unfinished proofread, chapters still needing a look. */
  private async openIssuesOf(drive: Drive): Promise<{ checked: number; issues: BookOpenIssue[] }> {
    const state = drive.store.state;
    const title = (id: string): string => drive.cards.get(id)?.title ?? "";
    const issues: BookOpenIssue[] = [];
    let checked = 0;
    const incomplete = (chapterTitle: string): void => {
      issues.push({ source: "ai-proof", chapterTitle, problem: "", reason: "proof_incomplete" });
    };
    for (const id of effectiveOrder(state)) {
      const proof = state.aiProof?.[id];
      if (!proof) continue;
      checked += proof.checked;
      for (const open of proof.open)
        issues.push({
          source: "ai-proof",
          chapterId: id,
          chapterTitle: title(id),
          problem: open.problem,
          reason: open.reason
        });
      if (proof.incomplete) incomplete(title(id));
    }
    if (state.bookProof) {
      checked += state.bookProof.checked;
      const chapters = state.bookProof.open.some(open => open.chapter !== undefined)
        ? (await this.bookProofInput(drive).catch(() => ({ chapters: [] }))).chapters
        : [];
      for (const open of state.bookProof.open) {
        const chapter = open.chapter === undefined ? undefined : chapters[open.chapter - 1];
        issues.push({
          source: "ai-proof",
          ...(chapter ? { chapterId: chapter.id } : {}),
          chapterTitle: chapter?.title ?? "",
          problem: open.problem,
          reason: open.reason
        });
      }
      if (state.bookProof.incomplete) incomplete("");
    }
    for (const id of effectiveOrder(state)) {
      if (drive.stages.get(id) !== "needs-review") continue;
      const info = drive.cards.get(id);
      const card = info ? await this.ports.readCard(info.path).catch(() => undefined) : undefined;
      const issue = String(card?.fields.pipelineIssue ?? "");
      const reason = /length:under/.test(issue)
        ? "too_short"
        : /length:over/.test(issue)
          ? "too_long"
          : /images:under/.test(issue)
            ? "few_images"
            : /no_body|no_text/.test(issue)
              ? "no_text"
              : /hand_edited/.test(issue)
                ? "hand_edited"
                : /^(plan|write|proof) failed/.test(issue)
                  ? "step_failed"
                  : "";
      issues.push({ source: "chapter", chapterId: id, chapterTitle: title(id), problem: "", reason });
    }
    return { checked, issues };
  }
  /** Writes the closing page (one retry). False when it could not be written: the book must not show as done. */
  private async writeClosingPage(drive: Drive): Promise<boolean> {
    const root = drive.cards.get(drive.rootId);
    if (!this.ports.writeOpenIssues || !root) return !this.ports.writeOpenIssues;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.dead(drive)) return false;
      try {
        const { checked, issues } = await this.openIssuesOf(drive);
        const content = composeOpenIssuesNote({
          bookTitle: root.title,
          language: drive.config.language,
          checked,
          issues
        });
        const folder = root.path.includes("/") ? root.path.slice(0, root.path.lastIndexOf("/")) : "";
        const written = await this.ports.writeOpenIssues(folder, drive.config.language, content);
        if (written.ok) return true;
      } catch {
        // retried once
      }
    }
    return false;
  }

  /** A card that finished its phase's last step (planned in planning, proofread in writing) adds its wall time to the estimate. */
  private recordDuration(
    drive: Drive,
    kind: PipelineStepKind,
    nodeId: string | undefined,
    now: number,
    phase: BookPipelineData["phase"]
  ): void {
    const begun = nodeId ? drive.started.get(nodeId) : undefined;
    if (begun === undefined || !nodeId) return;
    const list =
      phase === "planning" && kind === "plan"
        ? drive.durations.plan
        : phase === "writing" && kind === "proof"
          ? drive.durations.write
          : undefined;
    if (!list) return;
    list.push(Math.max(0, now - begun));
    drive.started.delete(nodeId);
  }

  private classify(drive: Drive, error: unknown): Outcome {
    if (isBudgetExhausted(error)) return { kind: "budget" };
    if (drive.controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
      return { kind: "cancelled" };
    return { kind: "failed", reason: reasonOf(error) };
  }
  private authorize(drive: Drive, token: StepToken, nodeId?: string): () => boolean {
    return () =>
      !this.dead(drive) &&
      !drive.controller.signal.aborted &&
      isCurrent(drive.store.state, token) &&
      // A card the reader removed from the map is not written, even by a call already in flight (plan §14-3).
      !(nodeId !== undefined && drive.members !== undefined && !drive.members.has(nodeId));
  }
  /**
   * The map file changed (the plugin's modify event): the drive of that map learns the card ids now, so a write already in flight to a
   * card that just left the map is refused synchronously at its commit. No drive: nothing to do.
   */
  async mapModified(mapPath: string): Promise<void> {
    const drive = this.drives.get(mapPath);
    if (!drive || this.dead(drive)) return;
    const map = await this.ports.readMap(mapPath).catch(() => undefined);
    if (map && !this.dead(drive)) drive.members = new Set(map.nodes.map(node => node.id));
  }
  private base(drive: Drive, model: string): BookStepBase {
    return { language: drive.config.language, model, reasoning: drive.config.reasoning, usageMapPath: drive.mapPath };
  }
  /** The card's current path when it is still on the map, else undefined (checked after the call, before any write). */
  private async stillOnMap(drive: Drive, nodeId: string): Promise<string | undefined> {
    const map = await this.ports.readMap(drive.mapPath);
    return map.nodes.find(node => node.id === nodeId)?.path;
  }
  private async ensureBackup(drive: Drive, nodeId: string, path: string, raw: string): Promise<boolean> {
    if (drive.backedUp.has(nodeId)) return true;
    const saved = await this.ports.backupNote(path, raw).catch(() => ({ ok: false as const }));
    if (saved.ok) {
      drive.backedUp.add(nodeId);
      drive.backupPaths.set(nodeId, saved.path);
    }
    return saved.ok;
  }
  private async writeFields(drive: Drive, nodeId: string, patch: PipelineFieldsPatch): Promise<void> {
    const info = drive.cards.get(nodeId);
    if (!info || this.dead(drive)) return;
    try {
      await this.ports.writePipelineFields(info.path, patch);
    } catch {
      // the card is gone or unreadable: the in-memory stage still leads the run
    }
  }
  /** The pipeline's role choice: true when written, false when the card's role is the owner's (or the card is gone). */
  private async writeRole(drive: Drive, nodeId: string, role: BookRole): Promise<boolean> {
    const info = drive.cards.get(nodeId);
    if (!info || this.dead(drive)) return false;
    try {
      if (this.ports.writePipelineRole) return await this.ports.writePipelineRole(info.path, role);
      const now = await this.ports.readCard(info.path);
      const f = now.fields;
      const byHand = !!f.pipelineRole && !!f.bookRole && f.bookRole !== f.pipelineRole;
      if (f.bookRoleBy === "owner" || byHand) {
        if (byHand && f.bookRoleBy !== "owner")
          await this.ports.writePipelineFields(info.path, { bookRoleBy: "owner" });
        return false;
      }
      await this.ports.writePipelineFields(info.path, { bookRole: role, pipelineRole: role });
      return true;
    } catch {
      return false;
    }
  }
  private async setStage(drive: Drive, nodeId: string, stage: PipelineStage, issue: string | null): Promise<void> {
    drive.stages.set(nodeId, stage);
    await this.writeFields(drive, nodeId, { pipelineStage: stage, pipelineIssue: issue });
  }
  private async markReview(drive: Drive, nodeId: string, step: PipelineStep, reason: string): Promise<void> {
    const failure = `${step} failed: ${code(reason)}`;
    // A failed rewrite of a chapter that still has its text keeps every reason it had (length, pictures, the proof's points) beside
    // the failure, and its latest proof section (live v6: 「寫作失敗」 alone replaced 「只有 2913 字」 and the picture shortfall).
    const issue =
      step === "write" && reason !== "hand_edited"
        ? carryIssue(failure, (await this.issueWithBody(drive, nodeId)) || drive.fixIssues.get(nodeId))
        : failure;
    drive.stages.set(nodeId, "needs-review");
    drive.reviewStep.set(nodeId, step);
    await this.writeFields(drive, nodeId, { pipelineStage: "needs-review", pipelineIssue: issue });
    if (step !== "plan" && issue === failure && !NO_FAILURE_SECTION.has(reason))
      await this.writeFailureSection(drive, nodeId, reason);
    this.syncReviewNotes(drive);
  }
  /**
   * The one automatic redo (plan 2026 flow v3, E), after every card has had its first round: a card whose proofread named unmet points
   * gets its text written again by the author alone (the plan and the checklist stay, attempts are not reset), then proofread once more.
   * The real points go to the author only (never to the proofread). A refused or no longer allowed request leaves the card needs-review.
   * Returns how many cards were sent back; only cards queued by this drive's own proofreads are considered.
   */
  private async startFixes(drive: Drive): Promise<number> {
    let started = 0;
    const queued = [...drive.fixable];
    drive.fixable.clear();
    for (const [nodeId, instruction] of queued) {
      if (this.dead(drive) || drive.controller.signal.aborted) break;
      if (drive.stages.get(nodeId) !== "needs-review") continue;
      // A kept chapter is not rewritten by an automatic redo (§8): no auto-fix for it.
      const kept = drive.cards.get(nodeId);
      const keptRaw = kept ? await this.ports.readCard(kept.path).catch(() => undefined) : undefined;
      if (keptRaw && isKeptRaw(keptRaw.raw)) continue;
      const done = await drive.store.commit(state => requestAutoFix(state, nodeId));
      if (!done?.accepted) continue;
      // The rewrite may pick this card's own pictures again (an expansion keeps them).
      const own = drive.cards.get(nodeId);
      const current = own ? await this.ports.readCard(own.path).catch(() => undefined) : undefined;
      if (current && !drive.expand.has(nodeId))
        for (const url of bodyImageUrls(current.detail)) drive.usedImages.delete(imageKey(url));
      drive.extra.set(nodeId, instruction);
      drive.avoid.add(nodeId);
      drive.reasons.delete(nodeId);
      drive.reviewStep.delete(nodeId);
      drive.imagesDone.delete(nodeId);
      const before = current?.fields.pipelineIssue;
      if (typeof before === "string" && before.trim()) drive.fixIssues.set(nodeId, before);
      else drive.fixIssues.delete(nodeId);
      drive.stages.set(nodeId, "planned");
      await this.writeFields(drive, nodeId, { pipelineStage: "planned", pipelineIssue: null });
      this.ports.log(
        formatPipelineLog({
          event: "auto_fix",
          runId: drive.store.state.runId,
          card: nodeId,
          step: "proof",
          attempt: 0,
          result: "unmet",
          ms: 0,
          counts: { round: autoFixesOf(drive.store.state, nodeId) }
        })
      );
      started++;
    }
    if (started) this.ports.progressed?.(drive.mapPath);
    return started;
  }
  /** The proof-result section of a card as `finalize`/`transform` text: the result with the models, or the failure line (never a model). */
  private proofSectionOf(
    drive: Drive,
    outcome: { result: ProofResult } | { failure: string },
    models: { model?: string; authorModel?: string },
    imageLine?: string
  ): (content: string) => string {
    const language = drive.config.language;
    const label = this.ports.modelLabel ? (id: string) => this.ports.modelLabel?.(id) ?? id : undefined;
    return content =>
      replaceProofSection(
        content,
        proofSectionHeading(language),
        composeProofSection(language, outcome, models, label, imageLine)
      );
  }
  /** Best effort: the card's proof-result section says "failed: reason" (no model). Never throws; skipped when nothing is known to be safe to write. */
  /** The card's issue now, when the card still has chapter text (the reasons that text still has); else undefined. */
  private async issueWithBody(drive: Drive, nodeId: string): Promise<string | undefined> {
    const info = drive.cards.get(nodeId);
    const card = info ? await this.ports.readCard(info.path).catch(() => undefined) : undefined;
    if (!card || !chapterBody(card.detail).trim()) return undefined;
    const issue = card.fields.pipelineIssue;
    return typeof issue === "string" ? issue : undefined;
  }
  private async writeFailureSection(drive: Drive, nodeId: string, reason: string): Promise<void> {
    try {
      if (this.dead(drive) || drive.controller.signal.aborted) return;
      const path = await this.stillOnMap(drive, nodeId);
      if (!path) return;
      const card = await this.ports.readCard(path);
      const next = programStampRaw(card.raw, this.proofSectionOf(drive, { failure: code(reason) }, {})(card.raw));
      if (next === card.raw || !(await this.ensureBackup(drive, nodeId, path, card.raw))) return;
      await this.ports.updateNoteRawGuarded(path, () => next, {
        expectedContent: card.raw,
        authorize: () => !this.dead(drive) && !drive.controller.signal.aborted
      });
    } catch {
      // the card still shows its issue field; the section is only a help for the reader
    }
  }
  private async reset(drive: Drive, nodeId: string): Promise<void> {
    drive.stages.set(nodeId, undefined);
    await this.writeFields(drive, nodeId, { pipelineStage: null, pipelineIssue: null });
    await drive.store.commit(state => ({ state: applyReset(state, nodeId), accepted: true }));
  }

  private async execGlobal(drive: Drive, token: StepToken): Promise<Outcome> {
    const signal = drive.controller.signal;
    const root = drive.cards.get(drive.rootId);
    const order = effectiveOrder(drive.store.state);
    if (!root || order.some(id => !drive.cards.has(id))) return { kind: "failed", reason: "missing" };
    const before = await this.ports.readCard(root.path);
    const structure = this.structureOf(drive, order);
    const request: GlobalPlanRequest = {
      ...this.base(drive, drive.config.planModel),
      bookTitle: before.title,
      settings: before.settings,
      cards: order.map(id => {
        const info = drive.cards.get(id) as CardInfo;
        const children = this.childCardsOf(drive, id).map(child => child.title);
        return {
          id,
          place: this.placeOf(drive, structure, id),
          title: info.title,
          summary: summaryText(info.summary),
          ...(children.length ? { children } : {})
        };
      })
    };
    const result: GlobalPlanResult = await untilAborted(
      signal,
      this.ports.runPlan(globalPlanStep, request, { signal, admission: drive.admission })
    );
    const path = await this.stillOnMap(drive, drive.rootId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    if (!(await this.ensureBackup(drive, drive.rootId, path, before.raw)))
      return { kind: "failed", reason: "backup_failed" };
    // The section's own heading is added by replaceBookPlanSection; its body (the ### parts) is the composed text after it.
    const section = composeBookPlan(
      { thread: result.thread, decisions: result.decisions, materials: result.materials },
      drive.config.language
    ).replace(/^## .*\n\n?/, "");
    const written = await this.ports.updateNoteRawGuarded(path, content => replaceBookPlanSection(content, section), {
      expectedContent: before.raw,
      authorize: this.authorize(drive, token)
    });
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    return {
      kind: "ok",
      after: async () => {
        for (const { id, role } of result.cards) {
          const info = drive.cards.get(id);
          if (!info || drive.ownerRoles.has(id)) continue;
          // The owner may have changed the role while the plan was awaited: the write decides again at commit.
          if (await this.writeRole(drive, id, role)) {
            info.role = role;
            continue;
          }
          const now = await this.ports.readCard(info.path).catch(() => undefined);
          const f = now?.fields;
          if (f?.bookRoleBy === "owner" || (f?.bookRole && f.pipelineRole && f.bookRole !== f.pipelineRole)) {
            drive.ownerRoles.add(id);
            info.role = f?.bookRole ?? role;
          } else info.role = role; // a failed write: the in-memory role still leads the run
        }
      }
    };
  }

  /** A card's children: a chapter's are its sections (every level below it), the preface's the chapters, a section has none. */
  private childCardsOf(drive: Drive, nodeId: string): { title: string; summary: string }[] {
    const structure = this.structureOf(drive, effectiveOrder(drive.store.state));
    const kind = structure.placeOf(nodeId)?.kind;
    const ids = kind === "chapter" ? structure.sectionsOf(nodeId) : kind === "preface" ? structure.chapters : [];
    return ids.flatMap(id => {
      const info = drive.cards.get(id);
      return info ? [{ title: info.title, summary: summaryText(info.summary) }] : [];
    });
  }

  /**
   * Whether the program may rewrite this chapter text: it is as the program left it (or there is none) and not kept, or the reader gave a
   * one-time permission for exactly this text. A kept choice wins over clean/empty: an older note the reader kept has no program fingerprint.
   */
  private mayOverwriteCard(drive: Drive, nodeId: string, raw: string): boolean {
    const state = bodyStateRaw(raw);
    // A kept text the program wrote itself ("accept as it is"): only the card's own rerun (the reader's explicit ask) rewrites it.
    if ((state === "clean" || state === "empty") && (!isKeptRaw(raw) || drive.rerun?.nodeId === nodeId)) return true;
    const permit = drive.overwrite.get(nodeId);
    return !!permit && permit.runId === drive.store.state.runId && permit.fingerprint === integrityFpRaw(raw);
  }

  private async execPlan(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    // The reader's own Summary (a kept chapter, or a card the pipeline never wrote that has text): the plan and the write keep it.
    if (
      (isKeptRaw(card.raw) && bodyStateRaw(card.raw) !== "clean") ||
      (bodyStateRaw(card.raw) === "unknown" && !pipelineWroteRaw(card.raw))
    )
      drive.ownSummary.add(nodeId);
    // A chapter the program may not rewrite (hand-edited, unknown or kept, and no permission) gets no plan: the write step would refuse it anyway.
    if (!this.mayOverwriteCard(drive, nodeId, card.raw)) {
      this.log(drive, "plan_skipped", nodeId, "plan", "hand_edited");
      drive.planSkipped.add(nodeId);
      return { kind: "ok", after: () => this.setStage(drive, nodeId, "planned", null) };
    }
    drive.planSkipped.delete(nodeId);
    const root = await this.ports.readCard(rootInfo.path);
    const book = parseBookPlanBody(root.raw);
    const settings = effectiveSettings(root.settings, parseBookPlanDecisions(root.raw));
    const order = effectiveOrder(drive.store.state);
    const structure = this.structureOf(drive, order);
    const around = structure.neighboursOf(nodeId);
    const kind = structure.placeOf(nodeId)?.kind ?? "chapter";
    const side = (id: string | undefined): CardNeighbour | undefined => {
      const other = id === undefined ? undefined : drive.cards.get(id);
      if (!other || id === undefined) return undefined;
      const place = structure.placeOf(id);
      const position = kind === "section" ? undefined : place?.kind === "preface" ? "preface" : place?.chapter;
      return {
        ...(position === undefined ? {} : { position }),
        title: other.title,
        summary: summaryText(other.summary)
      };
    };
    const previous = side(around.previous);
    const next = side(around.next);
    const nextChapter = side(around.nextChapter);
    const parentCard = around.parent === undefined ? undefined : drive.cards.get(around.parent);
    const parentChapter = around.parent === undefined ? undefined : structure.placeOf(around.parent)?.chapter;
    const children = this.childCardsOf(drive, nodeId);
    const request: CardPlanRequest = {
      ...this.base(drive, drive.config.planModel),
      thread: book.thread,
      settings,
      materials: book.materials,
      chapters: order.flatMap(id => {
        const own = id === nodeId ? card.title : drive.cards.get(id)?.title;
        return own === undefined ? [] : [{ place: this.placeOf(drive, structure, id), title: own }];
      }),
      ...(children.length ? { children } : {}),
      card: {
        id: nodeId,
        ...this.planPlaceOf(drive, structure, nodeId),
        role: info.role,
        title: card.title,
        summary: card.summary
      },
      ...(previous ? { previous } : {}),
      ...(next ? { next } : {}),
      ...(parentCard && parentChapter ? { parent: { position: parentChapter, title: parentCard.title } } : {}),
      ...(nextChapter ? { nextChapter } : {}),
      ...(drive.extra.has(nodeId) ? { instruction: drive.extra.get(nodeId) } : {})
    };
    // The chapter list is the authority and is never shortened: when it alone does not fit, the step is refused here (no call is made).
    if (!cardPlanFits(request)) {
      this.log(drive, "plan_refused", nodeId, "plan", "chapters_too_long");
      return { kind: "failed", reason: "chapters_too_long", forceReview: true };
    }
    const result: CardPlanResult = await untilAborted(
      signal,
      this.ports.runPlan(cardPlanStep, request, { signal, admission: drive.admission })
    );
    const path = await this.stillOnMap(drive, nodeId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
      return { kind: "failed", reason: "backup_failed", forceReview: true };
    // Always one line per accepted plan (also when nothing was dropped), so a run's log shows the filters did run: counts only.
    this.ports.log(
      formatPipelineLog({
        event: "checklist_dropped",
        runId: token.runId,
        card: nodeId,
        step: "plan",
        attempt: attemptsOf(drive.store.state, nodeId).plan,
        result: "ok",
        ms: 0,
        counts: {
          subjective: result.droppedSubjective ?? 0,
          picture: result.droppedPicture ?? 0,
          kept: result.checklist.length
        }
      })
    );
    const prompt = composeCardPrompt(
      {
        role: info.role,
        kind,
        covers: result.covers,
        ...(result.points ? { points: result.points } : {}),
        entry: result.entry,
        handoff: result.handoff,
        ...(request.parent ? { parent: request.parent } : {}),
        ...(previous ? { previous: { ...previous, summary: result.previous } } : {}),
        ...(next ? { next: { ...next, summary: result.next } } : {}),
        checklist: result.checklist,
        images: result.images
      },
      drive.config.language
    );
    const written = await this.ports.updateNoteGuarded(
      path,
      drive.ownSummary.has(nodeId) ? { prompt } : { prompt, summary: result.covers },
      { expectedContent: card.raw, authorize: this.authorize(drive, token, nodeId) }
    );
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    drive.plans.set(nodeId, result);
    return { kind: "ok", after: () => this.setStage(drive, nodeId, "planned", null) };
  }

  private async execWrite(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    drive.imagesDone.delete(nodeId);
    const card = await this.ports.readCard(info.path);
    const root = await this.ports.readCard(rootInfo.path);
    // The reader's hand: a chapter whose text is not as the program left it (or whose state is not known) is rewritten only with the
    // reader's one-time permission for exactly this text. The same check runs again inside the write itself (see `authorizeWrite`).
    const mayOverwrite = (raw: string): boolean => this.mayOverwriteCard(drive, nodeId, raw);
    if (!mayOverwrite(card.raw)) {
      // "Keep my version" was chosen for this very text: the chapter stays as it is and goes on to its proofread.
      if (isKept(card.detail)) {
        drive.imagesDone.add(nodeId);
        this.ports.log(
          formatPipelineLog({
            event: "hand_edit_kept",
            runId: token.runId,
            card: nodeId,
            step: "write",
            attempt: 0,
            result: "skipped",
            ms: 0
          })
        );
        return { kind: "ok", after: () => this.setStage(drive, nodeId, "written", null) };
      }
      this.ports.log(
        formatPipelineLog({
          event: "hand_edit_skipped",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt: 0,
          result: bodyStateRaw(card.raw),
          ms: 0
        })
      );
      return { kind: "failed", reason: "hand_edited", forceReview: true };
    }
    if (!(await this.ensureBackup(drive, nodeId, info.path, card.raw)))
      return { kind: "failed", reason: "backup_failed", forceReview: true };
    const authorize = this.authorize(drive, token, nodeId);
    let changedByHand = false;
    // The reader's notes (==text==%%備註#n：…%%) in the text this step started from: a note added (or taken off) before the write is
    // a change the author's text does not contain, so the write is refused like a hand edit (the note and the text stay).
    const notesOf = (raw: string): string =>
      findNotes(raw)
        .map(found => `${found.n}|${found.selected}|${found.note}`)
        .join("\n");
    const startNotes = notesOf(card.raw);
    const authorizeWrite = (current?: string): boolean => {
      if (!authorize()) return false;
      if (current === undefined) return true;
      if (mayOverwrite(current) && notesOf(current) === startNotes) return true;
      changedByHand = true;
      return false;
    };
    const slots = parseImageSlots(card.prompt);
    const settings = effectiveSettings(root.settings, parseBookPlanDecisions(root.raw));
    // The automatic redo (any reason; the length measured again now, so a changed setting counts) edits the chapter in place: the
    // author sees the chapter and returns only change blocks, which the program puts into the chapter as it is (one call; its pictures
    // and records stay). It never rewrites the chapter: an answer with no usable block leaves the chapter as it was, needs-review.
    const expanding = drive.avoid.has(nodeId) && drive.expand.has(nodeId);
    // A first write sees the whole plan (every chapter is planned before any is written); an in-place expansion does not.
    const chapters = expanding ? undefined : await this.authorChapters(drive, nodeId, card);
    let oldBody = chapterBody(card.detail);
    // The fix round asks for the setting's minimum itself (the 0.8x tolerance is only the first verdict's).
    let now = expanding ? lengthReason(settings.length, lengthBody(oldBody), undefined, true) : undefined;
    // The chapter's role and the other chapters (what it must not cover): told to the author, enforced in the merge.
    const scope = {
      role: info.role,
      others: effectiveOrder(drive.store.state).flatMap(id =>
        id === nodeId || id === drive.rootId ? [] : [drive.cards.get(id)?.title ?? ""].filter(Boolean)
      )
    };
    let requirements = expanding
      ? bookExpandRequirements(settings, oldBody, now, drive.extra.get(nodeId), scope)
      : undefined;
    let oldDetail = expanding ? detailBlockOf(card.raw) : undefined;
    let noEdits = false;
    let lostText = false;
    // What the latest in-place merge did (its log line) and how many characters it added to the chapter text.
    let stats = emptyExpandStats();
    let net = 0;
    const expand = (content: string): string | null => {
      const next = detailBlockOf(content);
      if (oldDetail === undefined || next === undefined) return content;
      const merged = expandChapterDetail(
        oldDetail,
        next,
        drive.config.language,
        fixInstructionText(requirements ?? ""),
        scope,
        stats
      );
      if (!merged) {
        noEdits = true;
        return null;
      }
      if (merged.dropped)
        this.ports.log(
          formatPipelineLog({
            event: "expand_capped",
            runId: token.runId,
            card: nodeId,
            step: "write",
            attempt: attemptsOf(drive.store.state, nodeId).write,
            result: "dropped",
            ms: 0,
            counts: { dropped: merged.dropped }
          })
        );
      // A process note the fix left in place (flagged, then copied through) goes now; one that carries a fact stays for the proofread.
      const scrubbed = dropProcessNotes(merged.detail);
      if (scrubbed.removed.length) merged.detail = scrubbed.detail;
      // A fix never drops a picture the chapter had, nor makes the chapter shorter than the asked minimum (or shorter than it was, if it already was).
      const body = chapterBody(merged.detail);
      const pictures = new Set(bodyImageUrls(`\n${body}`));
      const short = lengthReason(settings.length, lengthBody(body));
      if (
        bodyImageUrls(`\n${oldBody}`).some(url => !pictures.has(url)) ||
        (short?.kind === "under" && !(now?.kind === "under" && short.measured >= now.measured))
      ) {
        lostText = true;
        return null;
      }
      net = Array.from(body).length - Array.from(oldBody).length;
      return replaceDetailBlock(content, merged.detail);
    };
    // The body is cleaned inside the author's own write (same `vault.process`): only standard https pictures are ever saved, and
    // an unsafe body is refused whole, so the card keeps its text from before this step.
    let knownLines: ReadonlySet<string> = new Set(card.raw.split("\n"));
    const ownRecords = extractProofRecords(normalizeWorkRecords(card.detail)).map(quoteAll);
    let unsafe = false;
    // Which check refused the write (logged: live v5 showed only `unsafe_body`).
    let unsafeRule = "";
    let emptyBody = false;
    const finalize = (original: string): string | null => {
      // The card's own stored records come back from the card (carried below), never from what the author kept of them: an exact copy is cut out first.
      const cut = ownRecords.reduce((text, record) => text.split(record).join(""), original);
      const held = holdProofLines(cut, knownLines);
      const restore = held.restore;
      // R1-6: anchors become markdown links first; the picture scan and the cleaning then run on the final text. Placeholder sections go.
      const anchored = dropPlaceholderSections(convertSourceAnchors(held.text));
      const content = neutralizeDetail(anchored);
      if (content === null) {
        emptyBody = true;
        return null;
      }
      const urls = bodyImageUrls(content);
      const unsafeUrls = new Map(
        urls.filter(url => !isHttps(url)).map(url => [url, noPicture(drive.config.language, "unsafe")])
      );
      // An expansion validates before it transforms: what the answer adds to the chapter is refused whole, never cleaned, when it
      // carries a hidden callout or owner marker, a tag, or a picture that is not https.
      const oldUrls = oldDetail === undefined ? [] : bodyImageUrls(`\n${oldDetail}`);
      const allowed = new Set([...urls.filter(isHttps), ...oldUrls]);
      const check = (text: string, base: string, answer: string): string | undefined =>
        expansionUnsafeRule(text, base, new Set(answer.split("\n")), allowed, (body, ok) => this.exitCheck(body, ok));
      if (oldDetail !== undefined) {
        const answer = detailBlockOf(anchored) ?? "";
        const rule = unsafeUrls.size ? "picture_not_https" : check(answer, oldDetail, answer);
        if (rule) {
          unsafe = true;
          unsafeRule = `answer_${rule}`;
          return null;
        }
      }
      const cleaned = replaceBodyImages(content, unsafeUrls);
      if (this.exitCheck(cleaned, new Set(urls.filter(isHttps)))) {
        unsafe = true;
        unsafeRule = "exit_check";
        return null;
      }
      // An author result whose Detail holds no chapter text (only sources and notes) is refused: the card keeps its text.
      const detail = detailBlockOf(cleaned);
      if (detail !== undefined && !chapterBody(detail).trim()) {
        // Chapter text written inside a sources section is not moved back (shape cannot prove ownership): no_body, needs-review.
        emptyBody = true;
        return null;
      }
      // The text and its new fingerprint are one write: from here on the chapter counts as "as the program left it".
      // An expansion puts the cleaned change blocks into the chapter as it was, inside the same write; the merged text is checked
      // again as it will be saved (the old chapter's records and pictures stay; everything new must come from the cleaned answer).
      if (oldDetail === undefined) return stampRaw(restore(cleaned));
      const merged = expand(restore(cleaned));
      if (merged === null) return null;
      const final = detailBlockOf(merged);
      const rule =
        final === undefined || neutralizeDetail(merged) === null ? "shape" : check(final, oldDetail, detail ?? "");
      if (rule) {
        unsafe = true;
        unsafeRule = `merged_${rule}`;
        return null;
      }
      return stampRaw(merged);
    };
    // Why the author is called now (live v5: an intro's second writing call had no visible reason in the log).
    const attempt = attemptsOf(drive.store.state, nodeId).write;
    // One author call: pass 0 is the write (or the fix round), pass 1.. an extra expand pass of a chapter still too short.
    const callAuthor = (pass: number): Promise<AuthorOutcome> => {
      this.ports.log(
        formatPipelineLog({
          event: "author_call",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt,
          result: pass
            ? "expand_pass"
            : drive.rerun?.nodeId === nodeId
              ? "rerun"
              : expanding
                ? "fix_round"
                : drive.avoid.has(nodeId)
                  ? "source_swap"
                  : attempt > 1
                    ? "retry"
                    : "first_draft",
          ms: 0,
          counts: { round: autoFixesOf(drive.store.state, nodeId), ...(pass ? { pass } : {}) }
        })
      );
      // Nothing of this card's frontmatter is written while the author runs: the research write compares the whole file.
      return untilAborted(
        signal,
        this.ports.author({
          mapPath: drive.mapPath,
          nodeId,
          path: info.path,
          settings,
          slots: expanding ? [] : (slots ?? []),
          ...(chapters ? { chapters } : {}),
          language: drive.config.language,
          model: drive.config.authorModel,
          reasoning: drive.config.reasoning,
          ...(drive.avoid.has(nodeId) && !pass ? { instruction: drive.extra.get(nodeId) } : {}),
          ...(requirements !== undefined ? { keepSummary: true, requirements } : {}),
          ...(drive.ownSummary.has(nodeId) ? { keepSummary: true } : {}),
          ...(expanding ? { inPlace: true } : {}),
          signal,
          admission: drive.admission,
          authorize: authorizeWrite,
          finalize
        })
      );
    };
    // One line per in-place merge: what was asked, what the answer's blocks became (dropped per rule) and the characters it added.
    const logMerge = (pass: number, outcome: string): void => {
      if (!expanding) return;
      const ok = !unsafe && !noEdits && !lostText && !emptyBody && outcome === "written";
      this.ports.log(
        formatPipelineLog({
          event: "expand_merge",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt,
          result: unsafe ? "unsafe" : noEdits ? "no_edits" : lostText ? "lost_text" : emptyBody ? "no_body" : outcome,
          ms: 0,
          counts: {
            pass,
            requested: now?.kind === "under" ? lengthNeeded(now) : 0,
            ...stats,
            unsafe: unsafe ? 1 : 0,
            net: ok ? Math.max(net, 0) : 0,
            cut: ok ? Math.max(-net, 0) : 0
          }
        })
      );
    };
    const logRefused = (): void =>
      this.ports.log(
        formatPipelineLog({
          event: "write_refused",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt: attemptsOf(drive.store.state, nodeId).write,
          result: unsafeRule || "unknown",
          ms: 0
        })
      );
    const done = await callAuthor(0);
    logMerge(0, done.outcome);
    if (changedByHand) return { kind: "failed", reason: "hand_edited", forceReview: true };
    if (unsafe) {
      logRefused();
      return { kind: "failed", reason: "unsafe_body", forceReview: true };
    }
    // An in-place expansion of a short chapter whose answer had no usable block is a failed attempt, not the end: the remaining
    // expand passes still run, each asking for concrete new sections (live v6: 〈澆水〉 stopped at 2913 字 after one no_edits).
    let retryNoEdits = noEdits && expanding && now?.kind === "under";
    let wrote = !noEdits;
    if (noEdits && !retryNoEdits) return { kind: "failed", reason: "fix_no_edits", forceReview: true };
    if (done.outcome === "budget-exhausted") return { kind: "budget" };
    if (done.outcome === "cancelled") return { kind: "cancelled" };
    if (!retryNoEdits) {
      if (lostText) return { kind: "failed", reason: "fix_lost_text", forceReview: true };
      if (emptyBody) return { kind: "failed", reason: "no_body" };
      if (done.outcome === "failed") return { kind: "failed", reason: done.reason };
      if (done.outcome === "discarded") return { kind: "failed", reason: "discarded" };
    }
    // A chapter still under the minimum after the fix round gets up to BOOK_EXPAND_PASSES more expand passes, each only while the one
    // before added text or gave no usable block (live v5: one expand adds about 1.4–2.2k characters whatever is asked). A pass that is
    // refused or fails ends the passes; the chapter keeps what it has and the proofread's length reason sends it to a person.
    for (let pass = 1; expanding && now?.kind === "under" && pass <= BOOK_EXPAND_PASSES; pass++) {
      const at = await this.stillOnMap(drive, nodeId);
      if (!at) break;
      const latest = await this.ports.readCard(at);
      const body = chapterBody(latest.detail);
      const short = lengthReason(settings.length, lengthBody(body), undefined, true);
      if (short?.kind !== "under" || (!retryNoEdits && short.measured <= now.measured)) break;
      // The cap is per chapter and run, not per fix round (a trial chapter has two): counted and saved before the call.
      const used = await drive.store.commit(state => useExpandPass(state, nodeId));
      if (!used?.accepted) break;
      oldBody = body;
      now = short;
      oldDetail = detailBlockOf(latest.raw);
      requirements = bookExpandRequirements(
        settings,
        body,
        short,
        retryNoEdits ? BOOK_EXPAND_RETRY_INSTRUCTION : undefined,
        scope
      );
      knownLines = new Set(latest.raw.split("\n"));
      noEdits = lostText = unsafe = emptyBody = false;
      unsafeRule = "";
      stats = emptyExpandStats();
      net = 0;
      const more = await callAuthor(pass);
      logMerge(pass, more.outcome);
      if (changedByHand) return { kind: "failed", reason: "hand_edited", forceReview: true };
      if (unsafe) logRefused();
      if (more.outcome === "cancelled") return { kind: "cancelled" };
      // No usable block again: one more pass (while any is left) with the same stronger request.
      retryNoEdits = noEdits;
      if (noEdits) continue;
      // The merge refused this pass (its write left the chapter as the fix round saved it): the passes end here.
      if (unsafe || lostText || emptyBody) break;
      if (more.outcome === "discarded") return { kind: "failed", reason: "discarded" };
      if (more.outcome !== "written") break;
      wrote = true;
    }
    // Every pass gave no usable block (or none was left to use): the chapter stays as it was, needs-review.
    if (!wrote) return { kind: "failed", reason: "fix_no_edits", forceReview: true };
    drive.authorModels.set(nodeId, drive.config.authorModel);
    // What is saved holds only standard https pictures. The program (not the model) probes them; a failed one becomes a plain "no picture" line.
    const path = await this.stillOnMap(drive, nodeId);
    if (!path) return { kind: "failed", reason: "card_removed" };
    let written = await this.ports.readCard(path);
    // A rewrite that replaced the whole Detail drops the work records and the picture section: the card's earlier log lines, its latest proof record
    // (its lines are in `knownLines` by construction) and its `### 圖像` section come back; the next proof replaces the record.
    // The write-back's own log section (or an older Research notes section) is turned into the hidden callout first, the card's first write in the new form.
    // Only the card's own earlier content (never what the author wrote this time) is turned into the hidden form.
    const earlier = normalizeWorkRecords(card.detail);
    let carried = carryWorkLog(
      earlier,
      hidePipelineLog(written.detail, new Set(workLogLines(earlier)), drive.backupPaths.get(nodeId))
    );
    for (const record of extractProofRecords(earlier).slice(-1)) carried = appendResearchNote(carried, record).text;
    // #12: an old Prompt (no picture plan) keeps the card's picture section; a card with a plan gets its pictures from the slots.
    if (slots === undefined) carried = carryImageSection(card.detail, carried);
    if (carried !== written.detail) {
      const outcome = await this.ports.updateNoteGuarded(
        path,
        { detail: programStamp(written.detail, carried) },
        { expectedContent: written.raw, authorize }
      );
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
      written = await this.ports.readCard(path);
    }
    const replacements = new Map<string, string>();
    for (const url of bodyImageUrls(written.raw)) {
      const probed = await untilAborted(signal, this.ports.probeImage(url, signal)).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { ok: false as const, reason: "探測失敗" };
      });
      if (!probed.ok) replacements.set(url, noPicture(drive.config.language, probed.reason));
    }
    if (replacements.size) {
      const held = holdProofLines(written.raw, knownLines);
      const cleaned = programStampRaw(written.raw, held.restore(replaceBodyImages(held.text, replacements)));
      const outcome = await this.ports.updateNoteRawGuarded(path, () => cleaned, {
        expectedContent: written.raw,
        authorize
      });
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
    }
    // The picture slots (T2): the author's markers become verified pictures in one guarded write, or the stage does not advance.
    drive.sub.set(nodeId, { step: "images", startedAt: Date.parse(this.ports.now()) });
    this.ports.progressed?.(drive.mapPath);
    // An expansion keeps the chapter's pictures and their record: no new search, only a stray marker line goes.
    const filled = expanding
      ? await this.settleStrayMarkers(path, authorize)
      : await this.fillSlots(drive, token, nodeId, path, slots, authorize);
    if (filled) return filled;
    drive.imagesDone.add(nodeId);
    return {
      kind: "ok",
      after: async () => {
        await this.setStage(drive, nodeId, "written", null);
        await this.clearSeams(drive, nodeId);
      }
    };
  }

  /**
   * The whole run wrote this chapter again, beside its neighbours as they are now: the join marks of the chapter and of both neighbours
   * (left by an earlier single-card rerun) are stale and go (Primary decision). A single-card job sets its neighbours' marks itself.
   */
  private async clearSeams(drive: Drive, nodeId: string): Promise<void> {
    if (drive.job) return;
    const order = effectiveOrder(drive.store.state);
    const at = order.indexOf(nodeId);
    if (at < 0) return;
    for (const id of [order[at - 1], nodeId, order[at + 1]]) {
      const info = id ? drive.cards.get(id) : undefined;
      if (!info || this.dead(drive)) continue;
      const card = await this.ports.readCard(info.path).catch(() => undefined);
      if (card?.fields.pipelineSeam !== undefined) await this.writeFields(drive, id, { pipelineSeam: null });
    }
  }

  /**
   * The picture slots of one written card. No picture plan in the Prompt (`slots` undefined, #12): no search, no record, only a stray
   * marker line is deleted. With a plan: scan the markers, one search call for the slots that have a marker (an optional gain: a
   * failed or empty search leaves those slots `not_found`), probe the candidates (at most {@link PROBE_PER_CHAPTER} a chapter, at most
   * {@link PROBE_PARALLEL} in flight in the run), re-read the card, choose and claim the pictures in one synchronous turn, swap the
   * markers, verify, and write the text and the `book-slots:v1` record in one guarded write. Returns an outcome only when the step
   * ends (budget, a refused or discarded write); undefined means the markers are settled and the card may advance to written.
   */
  private async fillSlots(
    drive: Drive,
    token: StepToken,
    nodeId: string,
    path: string,
    slots: ImageSlot[] | undefined,
    authorize: () => boolean
  ): Promise<Outcome | undefined> {
    const signal = drive.controller.signal;
    const language = drive.config.language;
    const attempt = attemptsOf(drive.store.state, nodeId).write;
    if (!slots) return this.settleStrayMarkers(path, authorize);
    const first = await this.ports.readCard(path);
    const marked = slots.length ? scanSlotMarkers(first.detail, slots).found : new Map<number, number>();
    const others = new Set<string>();
    if (slots.length) {
      // What the other chapters already show (not this card's own old pictures: a rerun may pick again).
      for (const info of drive.cards.values())
        if (info.path !== path) {
          // A card deleted meanwhile is skipped: it must not fail this chapter.
          const other = await this.ports.readCard(info.path).catch(() => undefined);
          if (other) for (const url of bodyImageUrls(other.detail)) others.add(imageKey(url));
        }
    }
    const wanted = slots.filter(slot => marked.has(slot.index));
    const exclude = [...new Set([...drive.usedImages, ...others])];
    // One search call for `list`; a failed or timed-out call is an optional gain lost (undefined), never a failure of the chapter.
    const search = async (
      list: ImageSlot[],
      again: boolean,
      avoid: readonly string[]
    ): Promise<FoundImages | undefined> => {
      if (!list.length || !this.ports.findImages) return undefined;
      try {
        return await untilAborted(
          signal,
          this.ports.findImages(
            {
              ...this.base(drive, drive.config.imageModel),
              chapter: imageSearchText(first),
              slots: list.map(({ index, kind, explains }) => ({ index, kind, explains })),
              exclude: [...avoid],
              ...(again ? { again: true } : {})
            },
            { signal, admission: drive.admission }
          )
        );
      } catch (error) {
        if (isBudgetExhausted(error)) throw error;
        if (signal.aborted) throw error;
        return undefined;
      }
    };
    // Probe each distinct safe address once (the first PROBE_PER_CHAPTER in slot order, the limit covers both searches); the gate limits how many run at once.
    const probes = new Map<string, Promise<boolean>>();
    const loadedHref = new Map<string, boolean>();
    const probeFound = async (
      list: ImageSlot[],
      from: FoundImages | undefined
    ): Promise<Map<number, ProbedCandidate[]>> => {
      const listed = list.map(slot => ({
        index: slot.index,
        items: (from?.bySlot.get(slot.index) ?? []).map(candidate => {
          const href = safeHref(candidate.url);
          if (href && !probes.has(href) && probes.size < PROBE_PER_CHAPTER)
            probes.set(href, this.probeGated(drive, href));
          return { candidate, href };
        })
      }));
      await Promise.all(
        [...probes]
          .filter(([href]) => !loadedHref.has(href))
          .map(async ([href, work]) => loadedHref.set(href, await work))
      );
      return new Map(
        listed.map(({ index, items }) => [
          index,
          items.map(({ candidate, href }) => ({
            candidate: {
              imageUrl: candidate.url,
              sourceUrl: candidate.source,
              title: candidate.title,
              caption: candidate.caption,
              ...(candidate.description !== undefined ? { description: candidate.description } : {}),
              ...(candidate.author ? { author: candidate.author } : {}),
              ...(candidate.license ? { license: candidate.license } : {})
            },
            href,
            loaded: href ? (loadedHref.get(href) ?? false) : false,
            ...(href && !loadedHref.has(href) ? { skipped: true } : {})
          }))
        ])
      );
    };
    const perSlot = new Map<number, ProbedCandidate[]>();
    // A work key another chapter of this run claimed is taken; this chapter's own (a rerun) is not.
    const taken = (key: string): boolean =>
      drive.usedImages.has(key) || others.has(key) || (drive.usedWorks.get(key) ?? nodeId) !== nodeId;
    const hints = new Map<number, { subject?: string; search?: string }>();
    const keepHints = (from: FoundImages | undefined): void => {
      for (const [index, hint] of from?.hints ?? []) hints.set(index, { ...hints.get(index), ...hint });
    };
    let commonsAsked = 0;
    let commonsLimited = false;
    const commonsCut = new Set<number>();
    let commonsNoHint = 0;
    let commonsRejected: Partial<Record<CommonsRejection, number>> = {};
    const rounds: (FoundImages | undefined)[] = [];
    try {
      const round1 = await search(wanted, false, exclude);
      rounds.push(round1);
      keepHints(round1);
      for (const [index, list] of await probeFound(wanted, round1)) perSlot.set(index, list);
      // A second search (once) for the slots the first one left without a usable picture: another direction, the tried addresses excluded.
      if (round1) {
        const provisional = choosePictures({ id: nodeId, title: first.title }, slots, perSlot, taken, language);
        const lacking = wanted.filter(slot => !("figure" in (provisional.get(slot.index) ?? {})));
        const tried = [
          ...new Set([...perSlot.values()].flatMap(list => list.map(item => imageKey(item.candidate.imageUrl))))
        ];
        const second = await search(lacking, true, [...tried, ...exclude]);
        rounds.push(second);
        keepHints(second);
        if (second) {
          for (const [index, list] of await probeFound(lacking, second))
            perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
        }
      }
      // The program's own search (no model call) for the slots still without a usable picture: Wikimedia Commons, bounded per slot and
      // per chapter; its candidates are probed, deduped and chosen like the finder's.
      if (this.ports.fetchCommons) {
        const provisional = choosePictures({ id: nodeId, title: first.title }, slots, perSlot, taken, language);
        const lacking = wanted.filter(slot => !("figure" in (provisional.get(slot.index) ?? {})));
        if (lacking.length) {
          const seen = new Set([
            ...exclude,
            ...[...perSlot.values()].flatMap(list => list.map(item => imageKey(item.candidate.imageUrl)))
          ]);
          const commons = await searchCommons(
            lacking.map(slot => ({
              index: slot.index,
              kind: slot.kind,
              explains: slot.explains,
              ...(slot.search?.length ? { terms: slot.search } : {}),
              ...hints.get(slot.index)
            })),
            this.ports.fetchCommons,
            {
              signal,
              skip: url => seen.has(imageKey(url)) || taken(imageKey(url)),
              run: drive.commonsBudget,
              // The run's clock (a test's fake clock too): the chapter deadline and a Retry-After date are judged on it.
              now: () => Date.parse(this.ports.now()),
              ...(this.ports.commonsQueue ? { queue: this.ports.commonsQueue } : {})
            }
          );
          commonsAsked = commons.requests;
          commonsLimited = commons.limited;
          commonsRejected = commons.rejected;
          for (const index of commons.cut) commonsCut.add(index);
          // Slots with no English search words (none planned, none from the finder): their Commons queries are the slot line, which rarely matches a file.
          commonsNoHint = lacking.filter(slot => !slot.search?.length && !hints.get(slot.index)?.search).length;
          if (signal.aborted) throw new Error("aborted");
          const asFound: FoundImages = {
            bySlot: commons.bySlot,
            found: [...commons.bySlot.values()].reduce((n, list) => n + list.length, 0),
            offTopic: 0
          };
          for (const [index, list] of await probeFound(lacking, asFound))
            perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
        }
      }
    } catch (error) {
      if (isBudgetExhausted(error)) return { kind: "budget" };
      throw error;
    }
    // Re-read the latest text: the search and the probes took time, and the owner may have edited the card.
    const latest = await this.ports.readCard(path);
    // The card may have left the map while the search and the probes ran: nothing is claimed or written for it.
    if (!(await this.stillOnMap(drive, nodeId))) return { kind: "failed", reason: "card_removed" };
    // Addresses or works refused because this book already shows them (counted for the log).
    const refusedTaken = new Set<string>();
    const outcomes = choosePictures(
      { id: nodeId, title: latest.title },
      slots,
      perSlot,
      key => {
        const used = taken(key);
        if (used) refusedTaken.add(key);
        return used;
      },
      language
    );
    // A slot Commons' request limit kept from being searched says so (the shortfall reason then names the limit), not "not found".
    for (const index of commonsCut) {
      const outcome = outcomes.get(index);
      if (outcome && "reasonCode" in outcome && outcome.reasonCode === "not_found")
        outcomes.set(index, { reasonCode: "rate_limited" });
    }
    // Claim in the same synchronous turn as the choice: chapters run side by side, so the exclude list alone cannot stop a repeat.
    const claimed = [...outcomes.values()].flatMap(outcome =>
      "figure" in outcome ? [imageKey(outcome.figure.href)] : []
    );
    for (const key of claimed) drive.usedImages.add(key);
    const works = [...outcomes.values()].flatMap(outcome =>
      "figure" in outcome && outcome.figure.work && !drive.usedWorks.has(outcome.figure.work)
        ? [outcome.figure.work]
        : []
    );
    for (const key of works) drive.usedWorks.set(key, nodeId);
    // A placed file whose title and description (the finder's caption for its own pictures) name none of the words its slot asks
    // for is recorded as off its text: the proof then reports it as a mismatch without asking a model.
    const off = new Set<number>();
    for (const slot of slots) {
      const outcome = outcomes.get(slot.index);
      if (!outcome || !("figure" in outcome)) continue;
      const placed = (perSlot.get(slot.index) ?? []).find(item => item.href === outcome.figure.href)?.candidate;
      if (!placed) continue;
      const about = `${placed.title} ${placed.description ?? placed.caption}`;
      const words = askWords({ explains: slot.explains, terms: slot.search, ...hints.get(slot.index) });
      if (words.length && !wordHits(words, about)) off.add(slot.index);
    }
    const release = (): void => {
      for (const key of claimed) drive.usedImages.delete(key);
      for (const key of works) drive.usedWorks.delete(key);
    };
    try {
      const result = await this.writeFilled(latest, slots, outcomes, language, authorize, off);
      if (typeof result === "string") {
        release();
        return { kind: "failed", reason: result };
      }
      this.ports.log(
        formatPipelineLog({
          event: "slots",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt,
          result: "ok",
          ms: 0,
          counts: {
            placed: result.placed.length,
            missing: result.missing.length,
            ...(commonsAsked ? { commons: commonsAsked } : {}),
            ...(commonsLimited ? { commons_limited: 1 } : {}),
            ...(commonsNoHint ? { commons_nohint: commonsNoHint } : {}),
            ...Object.fromEntries(
              rounds.flatMap((round, i) =>
                round
                  ? [
                      [`r${i + 1}_found`, round.found],
                      [`r${i + 1}_offTopic`, round.offTopic]
                    ]
                  : []
              )
            ),
            ...(refusedTaken.size ? { taken: refusedTaken.size } : {}),
            ...Object.fromEntries(Object.entries(commonsRejected).map(([rule, n]) => [`commons_rej_${rule}`, n]))
          },
          hosts: { name: "reason", list: [...new Set(result.missing.map(item => item.reasonCode))] }
        })
      );
      return undefined;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** One probe through the run-wide gate: true when the picture loads. A probe that throws (not a Stop) counts as not loaded. */
  private async probeGated(drive: Drive, href: string): Promise<boolean> {
    const signal = drive.controller.signal;
    const gate = drive.probeGate;
    if (signal.aborted) throw new Error("aborted");
    if (gate.active < PROBE_PARALLEL) gate.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const grant = (): void => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const at = gate.waiters.indexOf(grant);
          if (at >= 0) gate.waiters.splice(at, 1);
          reject(new Error("aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        gate.waiters.push(grant);
      });
    try {
      const probed = await untilAborted(signal, this.ports.probeImage(href, signal)).catch((error: unknown) => {
        if (signal.aborted) throw error;
        return { ok: false as const };
      });
      return probed.ok;
    } finally {
      const next = gate.waiters.shift();
      if (next) next();
      else gate.active--;
    }
  }

  /**
   * Swaps the markers of `latest` for the chosen pictures and writes text plus record in one guarded write (the write is refused when
   * the card changed since `latest`, or a marker is left outside fences and quotes). Returns the fill result, or a failure reason
   * (nothing was written): the three checks, the exit check, or a discarded write.
   */
  private async writeFilled(
    latest: PipelineCard,
    slots: readonly ImageSlot[],
    outcomes: ReadonlyMap<number, SlotOutcome>,
    language: string,
    authorize: () => boolean,
    off?: ReadonlySet<number>
  ): Promise<FillResult | string> {
    const result = fillSlotMarkers(latest.detail, slots, outcomes);
    const bad = verifyFill(latest.detail, result, slots);
    if (bad) return `slots_${bad}`;
    // The exit check: nothing but the placed addresses may be an image in what this write adds.
    if (this.exitCheck(result.added.join("\n"), new Set(result.placed.map(item => item.href)))) return "slots_unsafe";
    const withSources = addPictureSources(result.text, result.sources, language);
    const slotted = slots.length ? replaceResearchRecord(withSources, composeSlotsRecord(result, off)) : withSources;
    // The slot fill is the program's own change of the text: its fingerprint follows only if the text it started from still had it.
    const detail = programStamp(latest.detail, slotted);
    if (detail === latest.detail) return result;
    const outside = residualMarkerLines(latest.raw).length - residualMarkerLines(latest.detail).length;
    const outcome = await this.ports.updateNoteGuarded(
      latest.path,
      { detail },
      {
        expectedContent: latest.raw,
        authorize,
        finalize: content => (residualMarkerLines(content).length > Math.max(0, outside) ? null : content)
      }
    );
    return outcome === "discarded" ? "discarded" : result;
  }

  /** An old Prompt has no picture plan: nothing is searched or recorded; a marker line the author left anyway is deleted (the card's own pictures stay). */
  private async settleStrayMarkers(path: string, authorize: () => boolean): Promise<Outcome | undefined> {
    const latest = await this.ports.readCard(path);
    if (!residualMarkerLines(latest.detail).length) return undefined;
    const result = await this.writeFilled(latest, [], new Map(), "", authorize);
    return typeof result === "string" ? { kind: "failed", reason: result } : undefined;
  }

  /** The independent exit check of an author result (a method so a test can force it to fail). */
  private exitCheck(cleaned: string, allowed: ReadonlySet<string>): boolean {
    return unsafeBody(cleaned, allowed);
  }

  private async execProof(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    if (!info) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    // "Keep my version" for this very text: the reader's answer is final, no proofread call; the chapter is done.
    if (isKeptRaw(card.raw)) return { kind: "ok", after: () => this.setStage(drive, nodeId, "checked", null) };
    const checklist = parseChecklist(card.prompt);
    const chapter = chapterBody(card.detail);
    const body = projectProofBody(stripImageLines(chapter));
    const imageCheck = checkImageText(chapter, parseImageSlots(card.prompt), latestSlotsRecord(card.detail));
    const imageLine = composeImageTextLine(drive.config.language, imageCheck);
    if (!checklist.length) return { kind: "failed", reason: "empty_list" };
    if (!body.trim()) return { kind: "failed", reason: "no_body" };
    const key = proofKey({
      runId: token.runId,
      nodeId,
      revision: cardRevision(drive.store.state, nodeId),
      body,
      checklist
    });
    // The length rule: a third reason beside the facts and the structure. It never lowers another failure; with nothing else wrong it
    // still makes the chapter need a look, and it stays so once the one automatic redo is spent (no silent "checked").
    const length = await this.lengthOf(drive, nodeId, lengthBody(chapter));
    const lengthIssue = length ? lengthToken(length) : "";
    // Fewer pictures than the owner's minimum, and any placed picture off its text, are reasons to look (never a rewrite of the
    // text): see pictureShortfallToken and pictureMismatchToken.
    const minimum = await this.pictureMinimum(drive);
    const limited = imageCheck.issues.some(issue => issue.code === "rate_limited");
    const offIndexes = imageCheck.issues.flatMap(issue =>
      issue.code === "mismatch" && issue.index !== undefined ? [issue.index] : []
    );
    const pictureIssue = [
      ...(minimum !== undefined && imageCheck.placed < minimum
        ? [pictureShortfallToken(imageCheck.placed, minimum)]
        : []),
      ...(limited ? [PICTURE_LIMITED_TOKEN] : []),
      ...(offIndexes.length ? [pictureMismatchToken(offIndexes)] : []),
      // So is a lowercase English word left in a Chinese caption (live v5: 「果實long在藤上」).
      ...[captionLatinIssue(chapter, drive.config.language)].filter(Boolean)
    ].join(" ");
    // The proof line says 「已校」 only when no length or picture reason is left beside a clean proof.
    const unresolved = !!lengthIssue || !!pictureIssue;
    let result: ProofResult | undefined = findStoredProof(card.detail, key);
    if (!result) {
      // A whole-card failure keeps the judgments already made (the structure items) in the research notes; the card still needs a human.
      const call = this.ports
        .runProofread(
          {
            ...this.base(drive, drive.config.authorModel),
            body,
            checklist: [...checklist, ...BOOK_CHECKS],
            title: card.title,
            role: drive.cards.get(nodeId)?.role,
            chapters: await this.proofChapters(drive, nodeId, card),
            readerNotes: readerCallouts(card.detail)
          },
          { signal, admission: drive.admission }
        )
        .catch(async (error: unknown) => {
          if (isProofFailure(error) && error.counts)
            this.logProofCounts(drive, token.runId, nodeId, error.counts, "failed");
          if (isProofFailure(error) && error.partial && !signal.aborted)
            await this.keepPartialProof(
              drive,
              token,
              nodeId,
              card,
              composeProofRecord(failedProofKey(key), error.partial, error.code)
            );
          throw error;
        });
      result = await untilAborted(signal, call);
      if (result.counts) this.logProofCounts(drive, token.runId, nodeId, result.counts, "ok");
      const path = await this.stillOnMap(drive, nodeId);
      if (!path) return { kind: "failed", reason: "card_removed" };
      if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
        return { kind: "failed", reason: "backup_failed", forceReview: true };
      const models = { model: drive.config.authorModel, authorModel: drive.authorModels.get(nodeId) };
      const written = await this.ports.updateNoteGuarded(
        path,
        { detail: replaceResearchRecord(card.detail, composeProofRecord(key, result, undefined, models, unresolved)) },
        {
          expectedContent: card.raw,
          authorize: this.authorize(drive, token),
          finalize: this.proofSectionOf(drive, { result }, models, imageLine)
        }
      );
      if (written === "discarded") return { kind: "failed", reason: "discarded" };
    } else {
      // R1-5: a stored result is reused, and the section still follows it: the model shown is the one stored with the result (never
      // today's setting); a record from before models were kept shows "not recorded".
      const stored = findStoredProofModels(card.detail, key);
      const models = {
        ...(stored?.model ? { model: stored.model } : {}),
        authorModel: drive.authorModels.get(nodeId) ?? stored?.authorModel
      };
      const judged: ProofResult = { ...result, aggregate: proofVerdict(result, false) };
      const relabeled = relabelProofRecord(card.raw, unresolved);
      const next = programStampRaw(
        relabeled,
        this.proofSectionOf(drive, { result: judged }, models, imageLine)(relabeled)
      );
      if (next !== card.raw) {
        const path = await this.stillOnMap(drive, nodeId);
        if (!path) return { kind: "failed", reason: "card_removed" };
        if (!(await this.ensureBackup(drive, nodeId, path, card.raw)))
          return { kind: "failed", reason: "backup_failed", forceReview: true };
        const written = await this.ports.updateNoteRawGuarded(path, () => next, {
          expectedContent: card.raw,
          authorize: this.authorize(drive, token)
        });
        if (written === "discarded") return { kind: "failed", reason: "discarded" };
      }
    }
    // The same reducer judges a fresh and a stored proof; a stored "checked" with every structure point unmet is needs-review.
    const verdict: ProofResult = { ...result, aggregate: proofVerdict(result, !body.trim()) };
    // Some unmet structure items do not stop the card: it stays checked, and the count is kept in its issue field for the card's small note.
    const structureUnmet = verdict.items
      .filter(item => item.type !== "fact" && item.status === "unmet")
      .map(item => code(item.id));
    const noticed = [...structureUnmet, ...imageIssueTokens(imageCheck)];
    return {
      kind: "ok",
      after: async () => {
        const rewrite = verdict.aggregate === "needs-review" || !!length;
        const stage = rewrite || pictureIssue ? "needs-review" : "checked";
        if (rewrite && !drive.job && autoFixesOf(drive.store.state, nodeId) === 0) {
          drive.fixable.set(
            nodeId,
            proofFixInstruction(verdict.items, [...checklist, ...BOOK_CHECKS], length, researchVoiceSentences(chapter))
          );
          drive.expand.add(nodeId);
        } else if (!drive.job) {
          drive.extra.delete(nodeId);
          drive.avoid.delete(nodeId);
          drive.expand.delete(nodeId);
        }
        await this.setStage(
          drive,
          nodeId,
          stage,
          verdict.aggregate === "needs-review"
            ? `${verdict.factsUnverified ? "proof unmet: facts_unverified" : `proof unmet: ${unmetIds(verdict.items)}`}${lengthIssue ? ` ${lengthIssue}` : ""}${pictureIssue ? ` ${pictureIssue}` : ""}`
            : lengthIssue
              ? `length unmet: ${[lengthIssue, ...(pictureIssue ? [pictureIssue] : []), ...noticed].join(" ")}`
              : pictureIssue
                ? `images unmet: ${[pictureIssue, ...noticed].join(" ")}`
                : structureUnmet.length
                  ? `structure unmet: ${noticed.join(" ")}`
                  : noticed.length
                    ? `image notice: ${noticed.join(" ")}`
                    : null
        );
      }
    };
  }

  /** The book's chapters for the author: the proofread's list with this chapter marked (the whole plan, so links and ownership are known). */
  private async authorChapters(
    drive: Drive,
    nodeId: string,
    card: { title: string; prompt: string }
  ): Promise<{ title: string; covers: string; current?: boolean }[]> {
    const ids = effectiveOrder(drive.store.state).filter(id => drive.cards.has(id));
    const chapters = await this.proofChapters(drive, nodeId, card);
    return chapters.map((chapter, at) => (ids[at] === nodeId ? { ...chapter, current: true } : chapter));
  }

  /** The book's chapters in reading order for the proofread: each title and its Prompt's covers line (an unreadable card keeps its title only). */
  private async proofChapters(
    drive: Drive,
    nodeId: string,
    card: { title: string; prompt: string }
  ): Promise<{ title: string; covers: string }[]> {
    const chapters: { title: string; covers: string }[] = [];
    for (const id of effectiveOrder(drive.store.state)) {
      const info = drive.cards.get(id);
      if (!info) continue;
      const other = id === nodeId ? card : await this.ports.readCard(info.path).catch(() => undefined);
      const covers = other ? (parseCardPrompt(other.prompt).covers ?? "") : "";
      chapters.push({ title: other?.title ?? info.title, covers: singleLineText(covers, PROOF_COVERS_MAX) });
    }
    return chapters;
  }

  /** The chapter's length reason against the effective `length` setting (read now, so a changed setting counts at once); a setting that cannot be read as one range is logged and not checked. */
  private async lengthOf(drive: Drive, nodeId: string, body: string): Promise<LengthReason | undefined> {
    const rootInfo = drive.cards.get(drive.rootId);
    if (!rootInfo) return undefined;
    const root = await this.ports.readCard(rootInfo.path);
    const settings = effectiveSettings(root.settings, parseBookPlanDecisions(root.raw));
    const ignored = (reason: LengthIgnored): void => this.log(drive, "length_rule_ignored", nodeId, "proof", reason);
    // After the automatic fix round the asked minimum itself holds: a chapter still below it needs a person.
    return lengthReason(settings.length, body, ignored, autoFixesOf(drive.store.state, nodeId) > 0);
  }

  /** The owner's minimum pictures per chapter (whole-book settings, see imageCountRange), or undefined without a picture setting. */
  private async pictureMinimum(drive: Drive): Promise<number | undefined> {
    const rootInfo = drive.cards.get(drive.rootId);
    if (!rootInfo) return undefined;
    const root = await this.ports.readCard(rootInfo.path);
    return imageCountRange(effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)))?.min;
  }

  /** Best effort: replaces the proof records in the research notes with the failed proof's partial record (its own key), under the same guards as every card write. Never throws. */
  private async keepPartialProof(
    drive: Drive,
    token: StepToken,
    nodeId: string,
    card: { raw: string; detail: string },
    record: string
  ): Promise<void> {
    try {
      const path = await this.stillOnMap(drive, nodeId);
      if (!path || !(await this.ensureBackup(drive, nodeId, path, card.raw))) return;
      await this.ports.updateNoteGuarded(
        path,
        { detail: replaceResearchRecord(card.detail, record) },
        { expectedContent: card.raw, authorize: this.authorize(drive, token) }
      );
    } catch {
      // The failure itself is still reported; the partial record is only a help for the reader.
    }
  }

  // ---- progress and log --------------------------------------------------------------------------------------------------------
  private progressOf(drive: Drive, active: boolean): BookPipelineProgress {
    const state = drive.store.state;
    const counts: BookPipelineProgress["counts"] = {
      pending: 0,
      planned: 0,
      written: 0,
      checked: 0,
      "needs-review": 0
    };
    for (const id of effectiveOrder(state)) counts[drive.stages.get(id) ?? "pending"]++;
    const eta = this.etaOf(drive, active);
    const imagesDone = [...drive.imagesDone].filter(id => {
      const stage = drive.stages.get(id);
      return effectiveOrder(state).includes(id) && stage !== "written" && stage !== "checked";
    }).length;
    return {
      runId: state.runId,
      phase: state.phase,
      status: state.status,
      ...(state.pauseReason ? { pauseReason: state.pauseReason } : {}),
      ...(state.pauseReason === "map" && state.changed
        ? { mapChange: { added: state.changed.added.length, missing: state.changed.missing.length } }
        : {}),
      ...(state.failureCode ? { failureCode: state.failureCode } : {}),
      active,
      total: effectiveOrder(state).length,
      counts,
      budget: { ...state.budget },
      startedAt: state.startedAt,
      phaseStartedAt: state.phaseStartedAt,
      busyCards: [...drive.busy].filter(id => id !== "global"),
      ...(eta === undefined ? {} : { etaSeconds: eta }),
      ...(active && drive.rerun ? { rerun: { ...drive.rerun } } : {}),
      ...(active && drive.sub.size
        ? { current: [...drive.sub].map(([nodeId, sub]) => ({ nodeId, step: sub.step, startedAt: sub.startedAt })) }
        : {}),
      steps: stepCounts(counts, imagesDone, {
        settled: state.phase === "gate2" || state.phase === "done",
        proofFailed: effectiveOrder(state).filter(
          id => drive.stages.get(id) === "needs-review" && drive.reviewStep.get(id) === "proof"
        ).length
      })
    };
  }
  /** Average wall time of the cards that finished this phase in this drive × cards left ÷ pool; undefined below {@link ETA_MIN_CARDS} finished cards. */
  private etaOf(drive: Drive, active: boolean): number | undefined {
    const state = drive.store.state;
    if (!active || state.status !== "running") return undefined;
    const planning = state.phase === "planning";
    if (!planning && state.phase !== "writing") return undefined;
    const list = planning ? drive.durations.plan : drive.durations.write;
    if (list.length < ETA_MIN_CARDS) return undefined;
    const left = effectiveOrder(state).filter(id => {
      const stage = drive.stages.get(id);
      return planning ? stage === undefined : stage !== "checked" && stage !== "needs-review";
    }).length;
    const average = list.reduce((sum, ms) => sum + ms, 0) / list.length;
    return Math.max(0, Math.round((average * left) / BOOK_POOL / 1000));
  }
  /** One line per proofread call: the numbers only (the call has no content log, so this is the trace of what it did). */
  private logProofCounts(drive: Drive, runId: string, nodeId: string, counts: ProofCounts, result: string): void {
    this.ports.log(
      formatPipelineLog({
        event: "proof_calls",
        runId,
        card: nodeId,
        step: "proof",
        attempt: attemptsOf(drive.store.state, nodeId).proof,
        result,
        ms: 0,
        counts: {
          openedPages: counts.openedPages,
          searches: counts.searches,
          ...(counts.sources
            ? {
                sourcesCited: counts.sources.sourcesCited,
                sourcesMatched: counts.sources.sourcesMatched,
                eventUrls: counts.sources.eventUrls
              }
            : {})
        },
        ...(counts.sources ? { hosts: { name: "unmatchedHosts", list: counts.sources.unmatchedHosts } } : {})
      })
    );
  }
  private log(drive: Drive, event: string, card: string, step: PipelineStep, result: string): void {
    this.ports.log(
      formatPipelineLog({ event, runId: drive.store?.state.runId ?? "-", card, step, attempt: 0, result, ms: 0 })
    );
  }
}
