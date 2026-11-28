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
import type { FindImagesRequest, FoundImage, FoundImages } from "../../core/steps/book-pipeline/find-images";
import type { ImageFit, ImageFitRequest } from "../../core/steps/book-pipeline/image-fit-check";
import type {
  AiBookChapter,
  AiBookProofRequest,
  AiProofRequest,
  AiProofRun
} from "../../core/steps/book-pipeline/ai-proof";
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
import { bookStructure, type BookStructure, type CardKind } from "../../core/book-pipeline/structure";
import { compactChapters, removedChapterRefs } from "../../core/book-pipeline/consistency";
import { directionFindings, numericFindings } from "../../core/book-pipeline/cross-checks";
import { isBudgetExhausted } from "../../core/admission";
import { createBudgetAdmission, createStoreBudgetPort } from "../../core/book-pipeline/budget";
import { imageKey } from "../../core/book-pipeline/image-dedupe";
import { formatPipelineLog } from "../../core/book-pipeline/log";
import {
  commonsQueue,
  commonsFileNameOf,
  commonsInfoFor,
  lookupCommonsFiles,
  searchCommons,
  slotCanBeChecked,
  unfitSlot,
  type CommonsFetch,
  type CommonsQueue,
  type CommonsRejection,
  type CommonsSlot,
  type CommonsRunBudget
} from "../../core/book-pipeline/commons-search";
import { askWords, wordHits } from "../../core/book-pipeline/file-fit";
import {
  figureLines,
  readFigure,
  retagRecordLine,
  slotsRecordLine,
  swapFigureStamped,
  type FigureSwap
} from "../../core/book-pipeline/refind-slot";
import { composeOpenIssuesNote, openIssuePictures, type BookOpenIssue } from "../../core/book-pipeline/open-issues";
import {
  PipelineStore,
  addBudget,
  acceptMapChange,
  advancePhase,
  applyBudgetExhausted,
  applyCancelled,
  applyPlanEditFailure,
  applyPlanEditStopped,
  applyPlanEditSuccess,
  beginPlanEdit,
  isPlanEditCurrent,
  PLAN_EDIT_BUSY,
  type PlanEditToken,
  abandonAi,
  closeAiRound,
  fixAgainPlan,
  keptForLocked,
  reopenAiRound,
  rekeyBookProof,
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
  gateWaitsForPerson,
  finishRun,
  invalidateStaleAiChapters,
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
  undoStructure,
  restructureAtReview,
  samePlanReview,
  stopRun,
  failRun,
  type PipelineAction,
  type PipelineStepKind,
  type StepToken
} from "../../core/book-pipeline/machine";
import {
  MAX_STEP_ATTEMPTS,
  attemptsOf,
  bookProofUnfinished,
  effectiveOrder,
  BOOK_EXPAND_PASSES,
  mapDifference,
  readBookPipeline,
  reserveBudget,
  type BookPipelineData,
  type StructureEditState,
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
  composeCardPrompt,
  parseBookPlanBody,
  parseBookPlanDecisions,
  parseCardPrompt,
  parseChecklist,
  parseCardCover,
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
import {
  COVER_INDEX,
  captionIsFileName,
  coverAsSlot,
  coverCandidates,
  coverFolderName,
  coverOffToken
} from "../../core/book-pipeline/cover";
import type { CoverDownload, CoverSaved } from "../../core/book-pipeline/cover-download";
import {
  commonsFilePage,
  coverDeclaredTarget,
  coverIsOff,
  coverLinkOf,
  coverOwnership,
  coverSourceKey,
  migrateLegacyCover,
  placeCover,
  putCoverBlock,
  readCoverRecord,
  removeCoverCredit,
  stripCoverBlock,
  trustedCoverBlock,
  type CoverRecordValue
} from "../../core/book-pipeline/cover-block";
import { isBadRequest } from "../../ai/bad-request";
import type { ReasoningLevel } from "../../ai/types";
import { translate, type ContentLanguage } from "../../i18n";
import type { MapDocument } from "../../map-model";
import { isPlaceholder } from "../../core/note-placeholder";
import type { NotePatch } from "../../repository";
import { isBookStepError, type BookStepBase } from "../../core/steps/book-pipeline/base";
import { stripFigureFences } from "../../core/book-pipeline/figure-spec";
import {
  checkDiagram,
  checkFigureDraft,
  type DiagramDraft,
  type DrawDiagramsRequest
} from "../../core/steps/book-pipeline/draw-diagrams";
import { isDiagramKind } from "../../core/steps/book-pipeline/find-images";
import type { MermaidSyntaxCheck } from "../../ai/mermaid-safety";
import {
  checkImageText,
  choosePictures,
  composeImageTextLine,
  diagramCaption,
  diagramTitle,
  composeSlotsRecord,
  imageIssueTokens,
  latestSlotsRecord,
  shortHash,
  pictureShortfallToken,
  captionLatinIssue,
  pictureMismatchToken,
  splitPictureIssue,
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
  type SlotDiagram,
  type SlotFigure,
  type SlotOutcome
} from "../../core/book-pipeline/image-slots";
import { cardPlanPlaceOf, neighbourPosition, planEditCardOf, writePlanEdits } from "../../core/book-pipeline/plan-edit";
import {
  changesBrief,
  planEditFits,
  planEditStep,
  type PlanEditCard,
  type PlanEditRequest
} from "../../core/steps/book-pipeline/plan-edit";
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
import { untilAborted } from "../../core/abort";
import {
  avoidSourcesInstruction,
  cardResultSnapshot,
  proofFixInstruction,
  sameReviewResult,
  type CardResultSnapshot
} from "./book-pipeline-rerun";
import { bookReadingOrder } from "./presentation-order";
import {
  structureAfterUndo,
  simulateStructure,
  undoClosure,
  undoAffected,
  reviewAffected,
  type AppliedOp,
  type SimulatedStructure,
  type StructureNode,
  type StructureOp
} from "../../core/book-pipeline/structure-edit";
import { arrangeMap, layoutOf } from "../../map-layout";
import type { StructureResult, StructureWork } from "./book-structure-port";

/** What one structure edit produced, for the caller to build the new run state from. */
interface StructureParts {
  order: string[];
  chapters: Record<string, { title: string; path: string }>;
  trial: BookPipelineData["trial"];
  /** The cards after the edit (the simulated tree, real ids), with their new titles. */
  nodes: StructureNode[];
  /** The ops that were applied, with the real ids of any new cards. */
  applied: AppliedOp[];
  archived: Record<string, string>;
}
import {
  bodyStateRaw,
  integrityFpRaw,
  isKept,
  isKeptRaw,
  mayRewriteRaw,
  programStamp,
  programStampRaw,
  readerSummaryRaw,
  stampRaw
} from "../../core/book-pipeline/body-integrity";

/** The replacement texts of the edits whose ids were written. */
const replacementsOf = (edits: readonly { id: string; replacement: string }[], ids: readonly string[]): string[] =>
  edits.filter(edit => ids.includes(edit.id)).map(edit => edit.replacement);
/** Id to the replacement that was written for it. */
const replacementMapOf = (
  edits: readonly { id: string; replacement: string }[],
  ids: readonly string[]
): Record<string, string> =>
  Object.fromEntries(edits.filter(edit => ids.includes(edit.id)).map(edit => [edit.id, edit.replacement]));
const appliedIdsOf = (outcomes: readonly { id: string; applied: boolean }[]): string[] =>
  outcomes.filter(outcome => outcome.applied).map(outcome => outcome.id);
/** At most this many cards are in a step at once (the whole-book plan runs alone before them). */
export const BOOK_POOL = 5;
/** The run keeps this many gate-press trace lines (the newest). */
const GATE_TRACE_MAX = 20;
/**
 * At most this many cards are in their post-write work at once: finding and placing pictures (cover download included) after the
 * author's call, and the proofreads (card_proof, AI proof, AI fix). A card in this phase does not hold a {@link BOOK_POOL} slot, so
 * the next write starts when a write ends. 10, not 5: a card's picture search and checks take about three times as long as its
 * write (about 75 s and 30 s against 45 s on a real 22-card book), so a cap of 5 would hold the writers back again. With 5 writes that
 * keeps the run at about 15 model calls at once, inside the 10 to 26 the old run already reached.
 */
export const BOOK_POST_POOL = 10;

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
  /** The note has `ai-locked: true`: nothing is asked of the model. */
  | "ai_locked"
  /** Applying notes: a notes job already holds this map; a drive does; the job was cancelled; the map or card changed meanwhile; the backup failed; no note to apply. */
  | "notes_busy"
  | "drive_running"
  | "cancelled"
  /** A gate button pressed while the drive was still ending: the drive stopped, failed or ended meanwhile, so the press did nothing. */
  | "gate_cancelled"
  | "stale"
  | "backup_failed"
  | "nothing"
  /** A rewrite the reader allowed was for a text that has changed since: nothing is rewritten. */
  | "text_changed"
  /** An undo that would make a card the editor did not add disappear: nothing is changed. */
  | "unsafe"
  /** Refind: the picture is not one the fill placed and recorded (the reader's own, moved or doubled): it is not searched for again. */
  | "not_slot";
/** The parts of a drive the picture search uses (see `searchPictures`): a refind of one slot builds its own. */
type PictureJob = Pick<Drive, "mapPath" | "controller" | "admission" | "config" | "commonsBudget" | "probeGate">;
/** What the picture search of one chapter found, and its counts for the log. */
interface PictureSearch {
  perSlot: Map<number, ProbedCandidate[]>;
  hints: Map<number, { subject?: string; search?: string }>;
  /** `${slot}|${url}` of the finder's unfit pictures offered as the last resort. */
  unfitKeys: Set<string>;
  /** `${slot}|${url}` of the pictures the look step said fit. */
  lookedFit: Set<string>;
  drawnDiagrams: Map<number, SlotDiagram>;
  commonsCut: Set<number>;
  commonsAsked: number;
  /**
   * Search calls asked (the finder's and Commons' requests) and how many of them answered: none of several answered is a provider that
   * failed (sign-in, connection), not a search that found nothing. Only the refind reads it; the fill keeps its own handling.
   */
  searchesAsked: number;
  searchesAnswered: number;
  commonsLimited: boolean;
  commonsNoHint: number;
  commonsRejected: Partial<Record<CommonsRejection, number>>;
  rounds: (FoundImages | undefined)[];
  finderUnfit: number;
  finderUnchecked: number;
  finderLookups: number;
  looks: number;
  looksUnfit: number;
  looksDropped: number;
  looksUnchecked: Set<string>;
  diagramStats: { asked: number; drawn: number; rejected: Record<string, number> };
}
/**
 * Why a placed picture is recorded as off its text: the finder's unfit picture taken as the last resort, or a file whose title and
 * description (the finder's caption for its own pictures) name none of the words its slot asks for and that no look said fits.
 */
function offText(
  slot: ImageSlot,
  figure: SlotFigure,
  found: Pick<PictureSearch, "perSlot" | "hints" | "unfitKeys" | "lookedFit">
): "unfit" | "words" | undefined {
  const placed = (found.perSlot.get(slot.index) ?? []).find(item => item.href === figure.href)?.candidate;
  if (!placed) return undefined;
  if (found.unfitKeys.has(`${slot.index}|${placed.imageUrl}`)) return "unfit";
  const about = `${placed.title} ${placed.description ?? placed.caption}`;
  const words = askWords({ explains: slot.explains, terms: slot.search, ...found.hints.get(slot.index) });
  return words.length && !wordHits(words, about) && !found.lookedFit.has(`${slot.index}|${placed.imageUrl}`)
    ? "words"
    : undefined;
}
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
  /** `ai-locked: true` in `raw`, read the way the write fence reads it: no AI call is made for this note. */
  aiLocked?: boolean;
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

const DETAIL_START = "<!-- visual-agent-map:detail:start -->";
const DETAIL_END = "<!-- visual-agent-map:detail:end -->";

/** What one fill writes for the card's cover: its record, `topic-cover`'s link and its Sources entry; `held` is set when the owner took the cover over meanwhile. */
interface CoverWrite {
  record: CoverRecordValue;
  link?: string;
  source?: { href: string; entry: string };
  held?: boolean;
}

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
   * The editor's structure changes as one map transaction (create, archive, rename, rewrite Map.md); a failure leaves the notes and the
   * map as they were. Absent: no change is applied (the proposal is only recorded).
   */
  editBookStructure?(mapPath: string, work: StructureWork): Promise<StructureResult>;
  /**
   * The book's closing page ("still open") in `folder`: creates it, or rewrites an earlier one of ours; a same-named note that is not ours
   * is never touched (another name is used). Absent: no page is written and the book is done without it. With `existingOnly` only an
   * earlier page of ours is rewritten; none: nothing is created and the result is ok with an empty path.
   */
  writeOpenIssues?(
    folder: string,
    language: ContentLanguage,
    content: string,
    existingOnly?: boolean
  ): Promise<{ ok: true; path: string } | { ok: false }>;
  /** The closing page's only items are these chapters (titles), skipped as locked (no new page): production shows a notice. */
  lockedSkipped?(titles: string[]): void;
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
  /**
   * Production: `runImageFitCheck(aiCalls, request, run)`: one AI call that looks at one picture (`request.imageDataUrl`) and answers whether it
   * shows what its position needs, plus a caption of what is visible. Absent (or no `fetchPicture`): non-Wikimedia candidates are placed unlooked.
   */
  lookAtImage?(request: ImageFitRequest, run: { signal: AbortSignal; admission?: AdmissionContext }): Promise<ImageFit>;
  /**
   * Production: downloads a candidate picture through `requestUrl` (https only, 8 MB, PNG/JPEG/GIF/WebP by its first bytes, 15 s), shrinks it for
   * the model's image input and returns it as a data URL; undefined when refused or failed. Never writes to the vault.
   */
  fetchPicture?(url: string, model: string, signal: AbortSignal): Promise<string | undefined>;
  /**
   * Production: `runDrawDiagrams(aiCalls, request, run)`: one tool-free call that may draw a short Mermaid chart from the chapter text for
   * each diagram-kind slot still without a picture. Absent: nothing is drawn.
   */
  drawDiagrams?(
    request: DrawDiagramsRequest,
    run: { signal: AbortSignal; admission?: AdmissionContext }
  ): Promise<DiagramDraft[]>;
  /** The "add diagrams" setting: false turns the drawing off. Absent: on. */
  diagramsOn?(): boolean;
  /** Production: the Mermaid parser check; a chart it calls invalid is dropped. Absent or "unavailable": the program checks alone. */
  mermaidSyntax?: MermaidSyntaxCheck;
  /** Production: a GET of a Wikimedia Commons API address through `requestUrl` (any other address is refused). Absent: no program search after the finder. */
  fetchCommons?: CommonsFetch;
  /** The queue every Commons request waits in. Absent: the shared production queue (1 s between requests); tests pass one without real waits. */
  commonsQueue?: CommonsQueue;
  /**
   * Production: `downloadCover(url, requestUrl-based fetch, { signal, userAgent })`: the cover picture's bytes, after the address, size, type
   * and magic-byte checks (only upload.wikimedia.org is ever asked). Absent: no cover is downloaded (the card's cover reads "not found").
   */
  fetchCoverImage?(url: string, signal: AbortSignal): Promise<CoverDownload>;
  /** Production: `saveCover(vault ports, folder, title, url, download, signal)`: a new file in the cover folder, or the one already there; never overwrites. */
  saveCover?(
    folder: string,
    title: string,
    sourceUrl: string,
    download: CoverDownload,
    signal: AbortSignal
  ): Promise<CoverSaved>;
  /** Production: `withCover`: the note text with `topic-cover: "[[link]]"` (the card's cover). Absent: the cover is recorded without it. */
  setCoverLink?(content: string, link: string): string;
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
  /** Memory only: a "fix again" round is running: slots finished of the slots it works on (the bar's "7 / 20"). */
  again?: { done: number; total: number };
  /** Memory only: a gate button press is waiting for the drive that reached the gate to finish ending. */
  gateWaiting?: true;
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
  | {
      kind: "failed";
      reason: string;
      forceReview?: boolean;
      /** The same request fails the same way: no attempt is left. */ final?: boolean;
    }
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
  /** Cards whose proofread named unmet points, waiting for the one automatic redo once that card's own first round is over: the program-built request line. */
  fixable: Map<string, string>;
  /** Cards whose automatic redo edits the chapter in place (the program puts the author's change blocks in), never writing it anew. */
  expand: Set<string>;
  /** The reader's one-time permission to rewrite a hand-edited chapter: bound to the run, the card, the operation and the text it was given for. */
  overwrite: Map<string, { runId: string; operation: string; fingerprint: string }>;
  /** In memory only: the single-card rerun in progress. */
  rerun?: { nodeId: string; startedAt: number };
  /** In memory only: the "fix again" round in progress (slots finished / slots to work on). */
  again?: { done: number; total: number };
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
  /** In memory only: the cards in their post-write work (counted against {@link BOOK_POST_POOL}, not {@link BOOK_POOL}); waiters for a free place. */
  post: Set<string>;
  postWaiters: Array<() => void>;
  /** Wakes the loop (a write has moved on to its pictures, so a new write may start). */
  wake?: () => void;
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
  /** True while the editor's structure change is being written: the map differs from the accepted set on purpose, so no pause for a map change. */
  structureBusy?: boolean;
  done: Promise<void>;
}

const code = (value: string): string => value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 60) || "failed";
const reasonOf = (error: unknown): string =>
  isProofFailure(error)
    ? error.code
    : isBookStepError(error)
      ? "invalid_reply"
      : isBadRequest(error)
        ? "bad_request"
        : "failed";
/** An unexpected error's code: only its class name, never its message (which could carry a path or a title). */
const internalCode = (error: unknown): string =>
  `internal_${(typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "unknown").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}`;
/** Failure reasons after which the card's proof-result section is not written (the write never reached the card, or the card is gone). */
const NO_FAILURE_SECTION: ReadonlySet<string> = new Set([
  "discarded",
  "ai_locked",
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

/** Pictures of at most this many non-Wikimedia candidates are looked at per chapter (one AI call each). */
export const LOOKS_PER_CHAPTER = 3;
/** A candidate on Wikimedia Commons (its file or its page): it keeps the file-page fit test and is never sent to be looked at. */
function isCommonsCandidate(candidate: { imageUrl: string; sourceUrl: string }): boolean {
  return [candidate.imageUrl, candidate.sourceUrl].some(raw => {
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return host === "upload.wikimedia.org" || host === "commons.wikimedia.org";
    } catch {
      return false;
    }
  });
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

/** The neighbour's "join not yet checked" line (a rerun and an applied note both write it). Shown to the reader, so it follows the map language itself (zh-CN stays Simplified), not the Traditional-only note.* text. */
function seamText(language: ContentLanguage, at: number, revision: number | string): string {
  return translate(language, "ui.book_seam_unchecked", at + 1, String(revision));
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

/**
 * What one refind job did: nothing found, every search call failed (the picture service did not answer; not the same as "none"), both
 * writing nothing, or the swap it wrote with the chapter's text before and after (the undo's input).
 */
export type RefindResult =
  | { kind: "none" }
  | { kind: "failed"; reason: "search_failed" }
  | { kind: "replaced"; path: string; before: string; after: string; swap: FigureSwap; language: string };

export class BookPipelineRuns {
  private readonly drives = new Map<string, Drive>();
  /** Maps with a gate press waiting for the drive that reached the gate to end (a second press meanwhile is refused as busy). */
  private readonly gateWaiting = new Set<string>();
  /** Trace lines of applied presses that ride on the drive's next state write (written alone when the drive ends first). */
  private readonly pendingTrace = new Map<string, { runId: string; lines: string[] }>();
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
    if (drive)
      return drive.store
        ? { ...this.progressOf(drive, true), ...(this.gateWaiting.has(mapPath) ? { gateWaiting: true as const } : {}) }
        : undefined;
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
    return this.gateEnter(
      "confirmGate1",
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
    return this.gateEnter("finishRun", mapPath, async drive => {
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
    return this.gateEnter(
      "retryTrial",
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
          if (current) this.releasePictures(drive, current);
        }
        this.log(drive, "gate1", "-", "plan", "trial_retry");
      },
      true
    );
  }

  /** The plan review: the owner chose to run the trial. The trial chapters are written from their plans as they are now. Refused (not_gate1) elsewhere. */
  async startTrial(mapPath: string): Promise<void> {
    return this.gateEnter(
      "startTrial",
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
    return this.gateEnter("backToPlan", mapPath, async drive => {
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
        if (current) this.releasePictures(drive, current);
        drive.stages.set(id, "planned");
        await this.writeFields(drive, id, { pipelineStage: "planned", pipelineIssue: null });
      }
      this.log(drive, "gate1", "-", "plan", "back_to_plan");
    });
  }

  /**
   * At gate 1: undoes the editor's structure changes (`opIds`, plus the later ones that lean on them, or "all"). One transaction puts the
   * parked notes back in Notes (their text untouched), parks the cards the editor added, and restores places and titles; then the run goes
   * back to planning and re-plans the cards whose neighbours or identity changed. Any parked note missing: nothing is changed. Refused
   * (not_gate1) outside a running gate 1; "busy" while a drive of the map runs. Neighbour lines and chapter numbers of the other cards are
   * rewritten by the program (no AI call). An id that was already undone, or none: no change.
   */
  async undoStructureEdit(mapPath: string, opIds: readonly string[] | "all"): Promise<void> {
    return this.gateEnter("undoStructure", mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath);
      const edit = data.structureEdit;
      if (data.phase !== "gate1" || data.status !== "running" || !edit) throw new BookPipelineRunError("not_gate1");
      const undone = new Set(edit.undone ?? []);
      const ids = [
        ...undoClosure(edit.applied, opIds === "all" ? edit.applied.map(a => a.id) : opIds, edit.before.rootId)
      ].filter(id => !undone.has(id));
      if (!ids.length) return;
      if (!this.ports.editBookStructure) throw new BookPipelineRunError("missing");
      const picked = new Set(ids);
      const order = effectiveOrder(data);
      const current: StructureNode[] = order.map(id => ({
        id,
        parentId: drive.parents.get(id) ?? null,
        title: drive.cards.get(id)?.title ?? ""
      }));
      const nodes = structureAfterUndo(
        { rootId: drive.rootId, nodes: current },
        edit.before,
        edit.applied,
        picked,
        undone
      );
      const nowIds = new Set(order);
      const newIds = new Set(nodes.map(n => n.id));
      const restored = nodes.map(n => n.id).filter(id => !nowIds.has(id));
      const dropped = order.filter(id => !newIds.has(id));
      // Only cards the editor added may vanish in an undo; anything else disappearing means the inverse is unsafe.
      const added = new Set(
        edit.applied.filter(a => picked.has(a.id) && a.op.kind === "add").map(a => (a.op as { ref: string }).ref)
      );
      if (dropped.some(id => !added.has(id))) throw new BookPipelineRunError("unsafe");
      const parkedAt = edit.archived ?? {};
      // Every parked note must still be there, or nothing is changed.
      for (const id of restored) {
        const at = parkedAt[id];
        if (
          !at ||
          !(await this.ports.readCard(at).then(
            () => true,
            () => false
          ))
        )
          throw new BookPipelineRunError("missing");
      }
      const titleOf = new Map(nodes.map(n => [n.id, n.title]));
      // The cards whose own plan no longer fits: the put-back ones, the merge targets, those that changed between chapter and section.
      const affected = undoAffected(drive.rootId, current, nodes, edit.applied, picked);
      const renamed = nodes.filter(n => nowIds.has(n.id) && drive.cards.get(n.id)?.title !== n.title);
      const parkedNow: Record<string, string> = {};
      let next: ((state: BookPipelineData) => BookPipelineData) | undefined;
      const work: StructureWork = {
        create: [],
        archive: dropped.map(id => ({ id, path: (drive.cards.get(id) as CardInfo).path })),
        restore: restored.map(id => ({ id, path: parkedAt[id] })),
        rename: renamed.map(n => ({ id: n.id, path: (drive.cards.get(n.id) as CardInfo).path, title: n.title })),
        edit: (map, tools) => {
          const byId = new Map(map.nodes.map(node => [node.id, node]));
          const renamedIds = new Set(renamed.map(n => n.id));
          const placed = nodes.map(item => {
            if (!nowIds.has(item.id))
              return {
                id: item.id,
                path: tools.pathOf(parkedAt[item.id]),
                parentId: item.parentId,
                x: 0,
                y: 0,
                collapsed: false
              };
            const own = byId.get(item.id);
            if (!own) throw new Error("card missing from the map");
            return {
              ...own,
              parentId: item.parentId,
              ...(renamedIds.has(item.id) ? { path: tools.pathOf(own.path) } : {})
            };
          });
          for (const id of dropped) {
            const node = byId.get(id);
            if (!node) throw new Error("card missing from the map");
            parkedNow[id] = tools.pathOf(node.path);
          }
          const survivors = new Set(placed.map(node => node.id));
          if (map.nodes.some(node => !survivors.has(node.id) && !dropped.includes(node.id)))
            throw new Error("map changed");
          map.nodes = arrangeMap(placed, undefined, undefined, layoutOf(map));
          const reading = bookReadingOrder(map);
          if (reading.length !== placed.length || reading.some(id => !survivors.has(id)))
            throw new Error("order differs");
          const parentOf = new Map(map.nodes.map(node => [node.id, node.parentId]));
          const chapters = Object.fromEntries(
            map.nodes.map(node => [node.id, { title: titleOf.get(node.id) ?? "", path: node.path }])
          );
          next = state => {
            const trial = bookStructure(reading, id => parentOf.get(id), drive.rootId).trialOf();
            const kept = Object.fromEntries(Object.entries(parkedAt).filter(([id]) => !restored.includes(id)));
            return undoStructure(
              {
                ...state,
                order: reading,
                accepted: [...reading],
                chapters,
                ...(state.trial ? { trial } : {}),
                structureEdit: { ...(state.structureEdit as StructureEditState), archived: { ...kept, ...parkedNow } }
              },
              ids,
              this.ports.now(),
              [...affected]
            );
          };
          const keptTrace = (map.bookPipeline as { gateTrace?: string[] } | undefined)?.gateTrace;
          const made = next(drive.store.state);
          map.bookPipeline = keptTrace ? { ...made, gateTrace: keptTrace } : made;
        }
      };
      const outcome = await this.writeStructure(
        drive,
        work,
        state => (next as (s: BookPipelineData) => BookPipelineData)(state),
        parkedNow,
        () => !this.dead(drive)
      );
      if (!outcome.ok) {
        this.log(drive, "structure_undo_failed", "-", "plan", outcome.code);
        if (outcome.rollbackFailed) throw new Error("structure_rollback");
        throw new BookPipelineRunError(this.dead(drive) ? "disposed" : "stale");
      }
      await this.pointHomesBack(drive, edit, picked);
      // The other cards' neighbour lines and numbers follow the restored order (a program rewrite; the loop's first round does it).
      for (const id of effectiveOrder(drive.store.state))
        if (id !== drive.rootId && !affected.has(id)) drive.planSkipped.add(id);
      this.log(drive, "gate1", "-", "plan", `undo_structure:${ids.length}`);
    });
  }

  /**
   * At the plan review (gate 1, before the trial): applies the structure ops the owner asked for in chat. `expect` is the run and tree the
   * proposal was made on; a different run or phase start is refused "not_gate1", a different tree "stale", and a drive of the map "busy"; a
   * refusal writes nothing. Removed notes are parked in Archive. The ops are appended to the gate's list (so 還原 works on them), only the
   * cards they touched are planned again (the editor's pass does not run), and the run returns to gate 1. Resolves with what was applied
   * as soon as the change is written (the re-plan goes on in the background; its failure is the run's own, shown by the bar).
   * `opening` is the chief editor's return line, or a function of the number of cards planned again.
   */
  async editStructureAtReview(
    mapPath: string,
    ops: readonly StructureOp[],
    expect: { runId: string; phaseStartedAt: string; nodes: readonly StructureNode[] },
    opening: string | ((affected: number) => string)
  ): Promise<{ applied: string[]; refused: { id: string; code: string }[]; affected: number }> {
    const result = { applied: [] as string[], refused: [] as { id: string; code: string }[], affected: 0 };
    await this.gateEnter(
      "editStructure",
      mapPath,
      async drive => {
        const data = await this.openSaved(drive, mapPath);
        if (!samePlanReview(data, expect)) throw new BookPipelineRunError("not_gate1");
        if (!this.ports.editBookStructure) throw new BookPipelineRunError("missing");
        const order = effectiveOrder(data);
        const baseNodes: StructureNode[] = order.map(id => ({
          id,
          parentId: drive.parents.get(id) ?? null,
          title: drive.cards.get(id)?.title ?? ""
        }));
        if (JSON.stringify(baseNodes) !== JSON.stringify(expect.nodes)) throw new BookPipelineRunError("stale");
        const sim = simulateStructure(
          { rootId: drive.rootId, nodes: baseNodes },
          ops,
          await this.lockedCards(drive, order)
        );
        result.refused = sim.rejected.map(r => ({ id: r.op.id, code: r.code }));
        if (!sim.applied.length) return;
        let affected: string[] = [];
        const { work, next, archived } = this.structureWork(drive, sim, baseNodes, [], (state, parts) => {
          const old = state.structureEdit;
          affected = [...reviewAffected(drive.rootId, baseNodes, parts.nodes, parts.applied)];
          return restructureAtReview(
            {
              ...state,
              order: parts.order,
              accepted: [...parts.order],
              chapters: parts.chapters,
              ...(state.trial ? { trial: parts.trial } : {}),
              structureEdit: {
                ...(old ?? { runId: state.runId, rejected: [], before: { rootId: drive.rootId, nodes: baseNodes } }),
                applied: [...(old?.applied ?? []), ...parts.applied],
                archived: { ...old?.archived, ...parts.archived }
              }
            },
            this.ports.now(),
            affected,
            typeof opening === "function" ? opening(affected.length) : opening
          );
        });
        const outcome = await this.writeStructure(drive, work, next, archived, () => !this.dead(drive));
        if (!outcome.ok) {
          this.log(drive, "structure_chat_failed", "-", "plan", outcome.code);
          if (outcome.rollbackFailed) throw new Error("structure_rollback");
          throw new BookPipelineRunError(this.dead(drive) ? "disposed" : "stale");
        }
        // The other cards' neighbour lines and numbers follow the new order (a program rewrite; the loop's first round does it).
        for (const id of effectiveOrder(drive.store.state))
          if (id !== drive.rootId && !affected.includes(id)) drive.planSkipped.add(id);
        result.applied = sim.applied.map(a => a.id);
        result.affected = affected.length;
        this.log(drive, "gate1", "-", "plan", `edit_structure:${sim.applied.length}`);
      },
      true
    );
    return result;
  }

  /** After an undo: the materials that were homed on a merged card (recorded at the merge) point at it again, and a home that names a card by the title of an undone rename names it by the old one. Best effort; a changed line is left. */
  private async pointHomesBack(drive: Drive, edit: StructureEditState, picked: ReadonlySet<string>): Promise<void> {
    try {
      const root = drive.cards.get(drive.rootId);
      if (!root) return;
      const card = await this.ports.readCard(root.path);
      const book = parseBookPlanBody(card.raw);
      let changed = false;
      const materials = book.materials.map(material => ({ ...material }));
      for (const a of edit.applied) {
        if (!picked.has(a.id) || a.op.kind !== "merge" || !a.before.homes?.length) continue;
        const target = drive.cards.get(a.op.into)?.title;
        for (const material of materials)
          if (target && material.home !== a.before.title && a.before.homes.includes(material.name)) {
            material.home = a.before.title;
            changed = true;
          }
      }
      // A card whose rename was undone: the homes that named it by the new title name it by the old one.
      for (const a of edit.applied)
        if (picked.has(a.id) && a.op.kind === "rename")
          for (const material of materials)
            if (material.home === a.op.title && material.home !== a.before.title) {
              material.home = a.before.title;
              changed = true;
            }
      if (!changed) return;
      const section = composeBookPlan(
        { thread: book.thread, decisions: parseBookPlanDecisions(card.raw), materials },
        drive.config.language
      ).replace(/^## .*\n\n?/, "");
      await this.ports.updateNoteRawGuarded(root.path, content => replaceBookPlanSection(content, section), {
        expectedContent: card.raw,
        authorize: () => !this.dead(drive)
      });
    } catch {
      // the homes keep the target's title; the plan reads the same
    }
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
      ["gate2", "done", "writing"],
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
      // The writing phase is open to a rerun only while the book is stopped (not a map pause): the run goes back to that stop afterwards.
      const stoppedWriting = data.phase === "writing";
      if (stoppedWriting && (data.status !== "stopped" || data.pauseReason === "map"))
        throw new BookPipelineRunError(refusal);
      const savedFailure = data.pauseReason === "failed" ? (data.failureCode ?? "failed") : undefined;
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
        try {
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
        } finally {
          // A rerun beside a stopped book: the book is stopped again (a failed stop keeps its code), unless the rerun ended it another
          // way. This runs even when the job threw, so the book is never left running.
          if (stoppedWriting && !this.dead(drive)) {
            await drive.store
              .commit(state => ({
                state:
                  state.phase === "writing" && state.status === "running"
                    ? savedFailure !== undefined
                      ? failRun(state, savedFailure)
                      : stopRun(state)
                    : state,
                accepted: true
              }))
              .catch(() => undefined);
          }
        }
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
    const proofread = stage === "checked" || stage === "needs-review";
    for (let turn = 0; proofread && turn < 20; turn++) {
      const state = drive.store.state;
      if (this.dead(drive)) return;
      if (drive.controller.signal.aborted || drive.fatal !== undefined) break;
      if (state.status !== "running" || state.aiProof?.[nodeId]?.done) break;
      drive.busy.add(nodeId);
      try {
        await this.aiChapter(drive, nodeId, state.aiProof?.[nodeId]?.step === "fix" ? "fix" : "proof", true);
      } finally {
        drive.busy.delete(nodeId);
      }
    }
    if (this.dead(drive) || drive.store.state.phase !== "done") return;
    // A rerun that ended without its chapter proofread (stopped, out of budget, failed, not written): the chapter's cleared slot is
    // closed as incomplete, so the bar and the page never show the book as solved, and the page is written again (a stopped run
    // may still write this: the book is finished, only this chapter's check is not).
    if (!drive.store.state.aiProof?.[nodeId]?.done && effectiveOrder(drive.store.state).includes(nodeId))
      await drive.store.commit(state => ({ state: abandonAi(state, nodeId), accepted: true }));
    if (!(await this.writeClosingPage(drive))) this.log(drive, "open_issues_write", nodeId, "proof", "failed");
  }

  /**
   * One more fix-and-check round over a finished book (the "fix again" button): every chapter whose AI proofread left fixable problems
   * gets one fix and one check, then the whole-book proofread the same way. The book stays done; the limit is raised to cover the calls
   * when it is short. A round cut short (stop, out of budget, unload) is closed with the problems the slot had before it, so the counts
   * the bar and the page show never move except by a finished round. Refused ("nothing") when no problem can be fixed.
   */
  async fixAgain(mapPath: string): Promise<void> {
    return this.enter(mapPath, async drive => {
      if (!this.ports.aiProof || !this.ports.aiFix || !this.ports.aiBookProof)
        throw new BookPipelineRunError("nothing");
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      if (data.phase !== "done") throw new BookPipelineRunError("not_gate");
      if (!fixAgainPlan(data, 0).items) throw new BookPipelineRunError("nothing");
      // Only the units that will really run are counted (the same key check the round makes: a hand-edited chapter is skipped), so the limit is raised for them alone.
      // A locked chapter (ai-flows AI lock) is not a unit; a round left with nothing but locked units is refused as locked, before any call.
      let lockedOut = false;
      const chapterKey = async (id: string): Promise<string | undefined> => {
        const info = drive.cards.get(id);
        const card = info ? await this.ports.readCard(info.path).catch(() => undefined) : undefined;
        return card
          ? aiProofKey(cardRevision(drive.store.state, id), aiProofBody(chapterBody(card.detail)))
          : undefined;
      };
      const keyOf = (input: { chapters: readonly { text: string }[] }): string =>
        aiProofKey(0, input.chapters.map(chapter => chapter.text).join("\n\u0000\n"));
      const bookKey = async (): Promise<string | undefined> => {
        const input = await this.bookProofInput(drive).catch(() => undefined);
        return input ? keyOf(input) : undefined;
      };
      const chapterIds: string[] = [];
      for (const id of effectiveOrder(data)) {
        const key = await chapterKey(id);
        if (key === undefined || !reopenAiRound(data, id, key).accepted) continue;
        const info = drive.cards.get(id);
        if (info && (await this.ports.readCard(info.path).catch(() => undefined))?.aiLocked) lockedOut = true;
        else chapterIds.push(id);
      }
      const input = await this.bookProofInput(drive).catch(() => undefined);
      const reopened = input !== undefined ? reopenAiRound(data, undefined, keyOf(input)) : undefined;
      let withBook = !!reopened?.accepted;
      // The book's round sends only its targets outside locked chapters: with none left it is refused as locked, not run as a bare re-check.
      if (
        withBook &&
        (reopened?.state.bookProof?.pending ?? []).every(t => input?.chapters[(t.chapter ?? 1) - 1]?.locked)
      ) {
        withBook = false;
        lockedOut = true;
      }
      if (!chapterIds.length && !withBook) throw new BookPipelineRunError(lockedOut ? "ai_locked" : "nothing");
      // The card says about 2 calls per unit; a step may be tried up to MAX_STEP_ATTEMPTS times, so the limit leaves room for
      // those retries (it is a cap, not a spend) and one failed call does not pause the round on "budget used up".
      const calls = (2 * chapterIds.length + (withBook ? 2 : 0)) * MAX_STEP_ATTEMPTS;
      await drive.store.commit(state => {
        const short = state.budget.used + calls - state.budget.limit;
        const next = resumeRun(short > 0 ? addBudget(state, short) : state);
        return { state: next ?? state, accepted: true };
      });
      if (drive.store.state.status !== "running") throw new BookPipelineRunError("budget");
      drive.job = async () => {
        drive.again = { done: 0, total: chapterIds.length + (withBook ? 1 : 0) };
        const finished = (): void => {
          if (drive.again) drive.again.done = Math.min(drive.again.total, drive.again.done + 1);
        };
        const live = (): boolean =>
          !this.dead(drive) &&
          !drive.controller.signal.aborted &&
          drive.fatal === undefined &&
          drive.store.state.status === "running";
        // The book slot first: its key is current now unless the reader edited a chapter. The chapter slots a book fix changes follow it (applyAiFix).
        let chaptersKey: string | undefined;
        try {
          if (withBook && live()) {
            const key = await bookKey();
            const opened =
              key !== undefined ? await drive.store.commit(state => reopenAiRound(state, undefined, key)) : undefined;
            for (let turn = 0; opened?.accepted && turn < 10; turn++) {
              const slot = drive.store.state.bookProof;
              if (!slot?.again || slot.done || !live()) break;
              await this.aiBook(drive, slot.step, true);
            }
            finished();
          }
          // The finished book proofread follows the program's own chapter fixes below (not a hand edit): its key is known to be current here.
          const before = await bookKey();
          if (before !== undefined && drive.store.state.bookProof?.key === before) chaptersKey = before;
          for (const id of chapterIds) {
            if (!live()) break;
            const key = await chapterKey(id);
            const opened =
              key !== undefined ? await drive.store.commit(state => reopenAiRound(state, id, key)) : undefined;
            if (!opened?.accepted) {
              finished();
              continue;
            }
            drive.busy.add(id);
            try {
              for (let turn = 0; turn < 10; turn++) {
                const slot = drive.store.state.aiProof?.[id];
                if (!slot?.again || slot.done || !live()) break;
                await this.aiChapter(drive, id, slot.step, true, true);
                // The book key follows the program's own write at once (not only when the round ends), so an unload at any point leaves it current.
                // A chapter whose text is no longer what the program wrote (a reader edit) is left alone: the book key then stays as it is.
                const written =
                  chaptersKey !== undefined
                    ? await this.ports.readCard(drive.cards.get(id)?.path ?? "").catch(() => undefined)
                    : undefined;
                const mine = !!written && mayRewriteRaw(written.raw);
                const after = mine ? await bookKey() : undefined;
                if (chaptersKey !== undefined && after !== undefined && after !== chaptersKey) {
                  const rekeyed = await drive.store
                    .commit(state => rekeyBookProof(state, chaptersKey!, after))
                    .catch(() => undefined);
                  if (rekeyed?.accepted) chaptersKey = after;
                }
              }
            } finally {
              drive.busy.delete(id);
              finished();
            }
          }
        } finally {
          drive.again = undefined;
          if (!this.dead(drive)) {
            await drive.store
              .commit(state => {
                let next = effectiveOrder(state).reduce((current, id) => closeAiRound(current, id), state);
                next = closeAiRound(next);
                return { state: next, accepted: true };
              })
              .catch(() => undefined);
            const from = chaptersKey;
            const after = from !== undefined ? await bookKey() : undefined;
            if (from !== undefined && after !== undefined)
              await drive.store.commit(state => rekeyBookProof(state, from, after)).catch(() => undefined);
            if (drive.store.state.phase === "done" && !(await this.writeClosingPage(drive)))
              this.log(drive, "open_issues_write", "book", "proof", "failed");
            this.syncReviewNotes(drive);
          }
        }
      };
      this.log(drive, "fix_again", "-", "proof", `calls:${calls}`);
    });
  }

  /**
   * A finished book is read again (the map opens; the one entry for this repair): a chapter with text that the book lists but that has
   * no finished AI proofread slot (a rerun cut short by an unload: its slot was cleared or left open and nothing closed it) is closed as incomplete and the
   * closing page is written again, so the bar and the page never show the book as solved. A book with no such chapter is not touched.
   */
  async repairFinished(mapPath: string): Promise<void> {
    if (this.disposed || !this.ports.aiProof || !this.ports.aiFix || !this.ports.aiBookProof) return;
    const read = readBookPipeline(await this.ports.readMap(mapPath));
    if (read.kind !== "usable" || read.data.phase !== "done") return;
    if (effectiveOrder(read.data).every(id => read.data.aiProof?.[id]?.done) && !read.data.bookProof?.again) return;
    return this.enter(mapPath, async drive => {
      const data = await this.openSaved(drive, mapPath, { allowDone: true });
      const missing: string[] = [];
      // A round of "fix again" cut short by an unload: the slot is closed with the problems it had, not given up as incomplete.
      const again = effectiveOrder(data).filter(id => data.aiProof?.[id]?.again && !data.aiProof[id].done);
      const bookAgain = !!data.bookProof?.again && !data.bookProof.done;
      for (const id of effectiveOrder(data)) {
        const info = drive.cards.get(id);
        if (
          data.aiProof?.[id]?.done ||
          data.aiProof?.[id]?.again ||
          !info ||
          (drive.stages.get(id) !== "checked" && drive.stages.get(id) !== "needs-review")
        )
          continue;
        const card = await this.ports.readCard(info.path).catch(() => undefined);
        if (card && aiProofBody(chapterBody(card.detail)).trim()) missing.push(id);
      }
      if ((!missing.length && !again.length && !bookAgain) || this.dead(drive)) return;
      await drive.store.commit(state => {
        if (state.phase !== "done") return { state, accepted: false };
        let next = again.reduce((current, id) => closeAiRound(current, id), state);
        if (bookAgain) next = closeAiRound(next);
        next = missing.reduce((current, id) => (current.aiProof?.[id]?.done ? current : abandonAi(current, id)), next);
        return { state: next, accepted: true };
      });
      if (!(await this.writeClosingPage(drive)))
        this.log(drive, "open_issues_write", missing[0] ?? again[0] ?? "book", "proof", "failed");
      this.syncNotes(drive);
    });
  }

  /**
   * A map opens: each card of a book that is not running whose text still holds the program's own intact old cover block gets the
   * `book-cover` key and a line in its Sources list instead (the block is taken out); an edited block stays as it is.
   */
  async migrateCovers(mapPath: string): Promise<void> {
    if (this.disposed || this.drives.has(mapPath) || this.notesJobs.has(mapPath) || this.ports.blocked(mapPath)) return;
    const doc = await this.ports.readMap(mapPath);
    const read = readBookPipeline(doc);
    if (read.kind !== "usable") return;
    const language = this.ports.config(mapPath).language;
    for (const id of effectiveOrder(read.data)) {
      const path = doc.nodes.find(node => node.id === id)?.path;
      if (!path) continue;
      // A run that started meanwhile owns the cards from here on.
      if (this.disposed || this.drives.has(mapPath) || this.notesJobs.has(mapPath) || this.ports.blocked(mapPath))
        return;
      try {
        const card = await this.ports.readCard(path);
        const moved = migrateLegacyCover(card.raw, language, card.title);
        if (!moved || coverOwnership(card.raw) !== "program") continue;
        // A text-only change: the block goes, the record line and the one credit line come in, everything else stays as the owner wrote it.
        const start = card.raw.indexOf(DETAIL_START);
        const end = card.raw.indexOf(DETAIL_END);
        if (moved.credit && (start < 0 || end < start)) continue;
        await this.ports.updateNoteRawGuarded(
          path,
          content => {
            let next = content;
            if (moved.credit) {
              const from = start + DETAIL_START.length;
              const inner = content.slice(from, end);
              const core = inner.trim();
              const lead = inner.slice(0, inner.indexOf(core));
              const stamped = programStamp(core, addPictureSources(core, [moved.credit], language));
              next = `${content.slice(0, from)}${lead}${stamped}${inner.slice(lead.length + core.length)}${content.slice(end)}`;
            }
            const placed = placeCover(next, moved.record);
            const link = "file" in moved.record ? coverLinkOf(moved.record.file) : undefined;
            return link && coverDeclaredTarget(placed) === undefined && this.ports.setCoverLink
              ? this.ports.setCoverLink(placed, link)
              : placed;
          },
          {
            expectedContent: card.raw,
            authorize: () => !this.disposed && !this.drives.has(mapPath) && !this.notesJobs.has(mapPath)
          }
        );
      } catch {
        // One card that cannot be read or written does not stop the others; it is tried again at the next open.
      }
    }
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
        if (!mayRewriteRaw(raw.raw)) continue;
        // A `previous` line's sentence is the plan's own (the earlier ideas the card stands on), so it is kept; only a `next` line is rewritten.
        const prompt = (key === "previous" ? retargetNeighbourLine : rewriteNeighbourLine)(
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
          const prompt = (key === "previous" ? retargetNeighbourLine : rewriteNeighbourLine)(
            raw.prompt,
            key,
            neighbourLine,
            structure.placeOf(nodeId)?.kind
          );
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
   * nothing), the call, a re-check (same run, card still in order, not ai-locked, not cancelled), then one writer transform. A late answer after a
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
    refuseIfGone();
    const notes = this.ports.notes;
    if (!notes) throw new BookPipelineRunError("unreadable");
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    refuseIfGone();
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
    if ((await this.ports.readCard(path).catch(() => undefined))?.aiLocked) throw new BookPipelineRunError("ai_locked");
    refuseIfGone();
    const items = snapshotNotes(raw);
    if (!items.length) throw new BookPipelineRunError("nothing");
    const sent = items.flatMap(item => (item.encoded ? [item.encoded] : [])).slice(0, MAX_NOTE_PARAGRAPHS);
    if (!sent.length) return { applied: 0, skipped: 0, marked: 0, edits: [] };
    // The copy comes first: when it fails nothing is spent and nothing is replaced.
    const saved = await this.ports.backupNote(path, raw).catch(() => ({ ok: false as const }));
    refuseIfGone();
    if (!saved.ok) throw new BookPipelineRunError("backup_failed");
    const rootNode = map.nodes.find(item => !item.parentId);
    const [card, root] = await Promise.all([
      this.ports.readCard(path),
      rootNode ? this.ports.readCard(rootNode.path) : undefined
    ]);
    refuseIfGone();
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
        refuseIfGone();
        await this.ports.updateMap(mapPath, doc => {
          refuseIfGone();
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
      refuseIfGone();
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
    // Re-check before the commit: same run, the card still in order and on the map, not locked meanwhile, no cancel.
    refuseIfGone();
    const fresh = await this.ports.readMap(mapPath);
    const again = readBookPipeline(fresh);
    refuseIfGone();
    if (again.kind !== "usable" || again.data.runId !== state.runId || !effectiveOrder(again.data).includes(nodeId))
      throw new BookPipelineRunError("stale");
    if (fresh.nodes.find(item => item.id === nodeId)?.path !== path) throw new BookPipelineRunError("stale");
    if ((await this.ports.readCard(path).catch(() => undefined))?.aiLocked) throw new BookPipelineRunError("ai_locked");
    refuseIfGone();
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

  /**
   * "Find another picture" for one placed picture of a chapter (V3.3 P5.1b). The notes slot: refused while a drive or another notes or
   * refind job holds the map. Only a picture the fill placed and recorded (the slot record's hash of `url`) is searched for again; a picture
   * the reader put in is refused ("not_slot"). The search is the fill's own (finder asked again with the book's pictures excluded, the
   * fit test, the probes, the look, Commons, the last resort), each model call one budget unit; no diagram is drawn. Order as the notes
   * job: reservation check, backup, the search, a re-check (same run, card in order, same path, not ai-locked, not cancelled), then one
   * writer transform that swaps only the picture's lines, its Sources entry and its record item. Nothing found, a cancel, a failure or
   * a text changed meanwhile writes nothing.
   */
  async refindSlot(
    mapPath: string,
    nodeId: string,
    url: string,
    options: { signal?: AbortSignal } = {}
  ): Promise<RefindResult> {
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
    const line = (result: string): void =>
      this.ports.log(
        formatPipelineLog({
          event: "refind_slot",
          runId: runId.value,
          card: nodeId,
          step: "write",
          attempt: 0,
          result,
          ms: Date.now() - started
        })
      );
    try {
      const result = await this.runRefind(mapPath, nodeId, url, job, runId);
      line(result.kind === "replaced" ? "ok" : result.kind === "failed" ? result.reason : "none");
      return result;
    } catch (error) {
      line(error instanceof BookPipelineRunError ? error.code : internalCode(error));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.notesJobs.delete(mapPath);
    }
  }

  private async runRefind(
    mapPath: string,
    nodeId: string,
    url: string,
    job: AbortController,
    runIdOut: { value: string }
  ): Promise<RefindResult> {
    const signal = job.signal;
    const gone = (): boolean => signal.aborted || this.disposed;
    const refuseIfGone = (): void => {
      if (gone()) throw new BookPipelineRunError(this.disposed ? "disposed" : "cancelled");
    };
    refuseIfGone();
    const notes = this.ports.notes;
    if (!notes) throw new BookPipelineRunError("unreadable");
    if (this.ports.blocked(mapPath)) throw new BookPipelineRunError("blocked");
    const map = await this.ports.readMap(mapPath);
    refuseIfGone();
    const read = readBookPipeline(map);
    if (read.kind === "absent") throw new BookPipelineRunError("missing");
    if (read.kind === "unusable") throw new BookPipelineRunError("unusable");
    const state = read.data;
    runIdOut.value = state.runId;
    const order = effectiveOrder(state);
    const node = map.nodes.find(item => item.id === nodeId);
    if (!node || !order.includes(nodeId)) throw new BookPipelineRunError("missing");
    if (!reserveBudget(state.budget)) throw new BookPipelineRunError("budget");
    const path = node.path;
    let raw: string;
    let card: PipelineCard;
    try {
      [raw, card] = await Promise.all([notes.readText(path), this.ports.readCard(path)]);
    } catch {
      throw new BookPipelineRunError("unreadable");
    }
    refuseIfGone();
    if (card.aiLocked) throw new BookPipelineRunError("ai_locked");
    const config = this.ports.config(mapPath);
    const language = config.language;
    // Only a picture the fill placed and recorded, still where it wrote it: a picture the reader put in (or moved, or doubled) is theirs.
    const detail = detailBlockOf(raw) ?? "";
    const item = latestSlotsRecord(detail)?.slots.find(
      entry => entry.state === "placed" && entry.hash === shortHash(url)
    );
    const slot = item ? parseImageSlots(card.prompt)?.find(entry => entry.index === item.index) : undefined;
    const block = readFigure(raw, url, language);
    const recordLine = slotsRecordLine(raw);
    if (!item || !slot || !block || !recordLine) throw new BookPipelineRunError("not_slot");
    // The copy comes first: when it fails nothing is spent and nothing is replaced.
    const saved = await this.ports.backupNote(path, raw).catch(() => ({ ok: false as const }));
    refuseIfGone();
    if (!saved.ok) throw new BookPipelineRunError("backup_failed");
    // What the book shows elsewhere (the other chapters' pictures and covers), this chapter's other pictures and cover, and the picture
    // being replaced: none of them is offered again.
    const avoid = new Set<string>([imageKey(url), ...bodyImageUrls(detail).map(imageKey)]);
    const own = coverSourceKey(raw);
    if (own) avoid.add(own);
    for (const id of order) {
      const other = id === nodeId ? undefined : map.nodes.find(entry => entry.id === id);
      const page = other ? await this.ports.readCard(other.path).catch(() => undefined) : undefined;
      if (!page) continue;
      for (const href of bodyImageUrls(page.detail)) avoid.add(imageKey(href));
      const cover = coverSourceKey(page.raw);
      if (cover) avoid.add(cover);
    }
    refuseIfGone();
    // Every model call is one unit, saved through the map guard before the provider is asked (as the notes job's).
    const store = new PipelineStore(state, next =>
      this.ports.mutate(async () => {
        refuseIfGone();
        await this.ports.updateMap(mapPath, doc => {
          refuseIfGone();
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
    const pictures: PictureJob = {
      mapPath,
      controller: job,
      admission: createBudgetAdmission(createStoreBudgetPort(store)),
      config,
      commonsBudget: { waited: 0, spent: false },
      probeGate: { active: 0, waiters: [] }
    };
    const taken = (key: string): boolean => avoid.has(key);
    let found: PictureSearch;
    try {
      refuseIfGone();
      found = await this.searchPictures(
        pictures,
        card,
        [slot],
        new Map([[slot.index, 0]]),
        undefined,
        [...avoid],
        taken,
        { again: true, draw: false }
      );
    } catch (error) {
      if (error instanceof BookPipelineRunError) throw error;
      if (isBudgetExhausted(error)) throw new BookPipelineRunError("budget");
      refuseIfGone();
      throw error;
    } finally {
      store.dispose();
    }
    refuseIfGone();
    const outcome = choosePictures([slot], found.perSlot, taken, language).get(slot.index);
    const figure = outcome && "figure" in outcome ? outcome.figure : undefined;
    if (!figure)
      return found.searchesAsked > 0 && found.searchesAnswered === 0
        ? { kind: "failed", reason: "search_failed" }
        : { kind: "none" };
    const to = figureLines(figure, block.lines[0].endsWith("\r"));
    // The exit check: the new lines may show this one picture and nothing else.
    if (this.exitCheck(to.join("\n"), new Set([figure.href]))) throw new Error("slots_unsafe");
    const retagged = retagRecordLine(recordLine, slot.index, shortHash(figure.href), !!offText(slot, figure, found));
    if (!retagged) throw new BookPipelineRunError("not_slot");
    const swap: FigureSwap = {
      block: { from: block.lines, to },
      entry: {
        ...(block.entry !== undefined ? { from: block.entry, ...(block.href ? { fromHref: block.href } : {}) } : {}),
        ...(figure.source ? { to: figure.source.entry, href: figure.source.href } : {})
      },
      record: { from: recordLine, to: retagged }
    };
    // Re-check before the commit: same run, the card still in order and on the map at the same path, not locked meanwhile, no cancel.
    const fresh = await this.ports.readMap(mapPath);
    const again = readBookPipeline(fresh);
    refuseIfGone();
    if (again.kind !== "usable" || again.data.runId !== state.runId || !effectiveOrder(again.data).includes(nodeId))
      throw new BookPipelineRunError("stale");
    if (fresh.nodes.find(entry => entry.id === nodeId)?.path !== path) throw new BookPipelineRunError("stale");
    if ((await this.ports.readCard(path).catch(() => undefined))?.aiLocked) throw new BookPipelineRunError("ai_locked");
    refuseIfGone();
    let done: { before: string; after: string } | undefined;
    const written = await notes.write(path, text => {
      done = undefined;
      // The last gate, inside the write: a cancel that came while the writer waited changes nothing.
      if (gone()) return text;
      const next = swapFigureStamped(text, swap, language);
      if (next === undefined) return text;
      done = { before: text, after: next };
      return next;
    });
    if (!(written === "written" && done)) {
      refuseIfGone();
      throw new BookPipelineRunError("stale");
    }
    const { before, after } = done;
    return { kind: "replaced", path, before, after, swap, language };
  }

  /** The body changed: both neighbours' joins are worth a look, as after a rerun. */
  private async markNeighbourSeams(
    mapPath: string,
    state: BookPipelineData,
    nodeId: string,
    language: ContentLanguage,
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
  /** True while the drive is only winding down after it reached a gate (it started no job of its own and nothing stopped it). */
  private windingDownAtGate(drive: Drive): boolean {
    const state = drive.store?.state;
    return (
      !!state &&
      !drive.job &&
      // Only a gate that waits for the owner: at any other gate phase the drive is still working (a trial being written, the last fixes).
      ((state.phase === "gate1" && gateWaitsForPerson(state, state.planReview ? "plan" : "trial")) ||
        (state.phase === "gate2" && gateWaitsForPerson(state, "final"))) &&
      state.status === "running" &&
      !drive.stopRequested &&
      drive.fatal === undefined &&
      !this.dead(drive)
    );
  }
  /**
   * A gate button entry. A press made while the drive that reached the gate is still ending waits for that drive and then applies as
   * it would have (a stopped, failed or disposed drive: the press does nothing, "gate_cancelled"); a press while a different operation runs,
   * or a second press while one waits, is refused "busy". Every press leaves one short trace line in the run (action, outcome, wait).
   */
  private async gateEnter(
    action: string,
    mapPath: string,
    setup: (drive: Drive) => Promise<void>,
    early = false
  ): Promise<void> {
    const runId = await this.ports.readMap(mapPath).then(
      map => {
        const read = readBookPipeline(map);
        return read.kind === "usable" ? read.data.runId : undefined;
      },
      () => undefined
    );
    const startedAt = Date.now();
    let waited = 0;
    try {
      const drive = this.drives.get(mapPath);
      if (drive && !this.gateWaiting.has(mapPath) && this.windingDownAtGate(drive)) {
        this.gateWaiting.add(mapPath);
        this.ports.progressed?.(mapPath);
        try {
          await drive.done.catch(() => undefined);
        } finally {
          this.gateWaiting.delete(mapPath);
          this.ports.progressed?.(mapPath);
        }
        waited = Date.now() - startedAt;
        if (this.disposed) throw new BookPipelineRunError("disposed");
        if (drive.stopRequested || drive.fatal !== undefined || this.dead(drive))
          throw new BookPipelineRunError("gate_cancelled");
      }
      await this.enter(mapPath, setup, early);
      await this.traceGate(mapPath, runId, action, "applied", waited, true);
    } catch (error) {
      await this.traceGate(
        mapPath,
        runId,
        action,
        `refused:${error instanceof BookPipelineRunError ? error.code : "error"}`,
        waited
      );
      throw error;
    }
  }
  private async traceGate(
    mapPath: string,
    runId: string | undefined,
    action: string,
    outcome: string,
    waited: number,
    defer = false
  ): Promise<void> {
    if (this.disposed || runId === undefined) return;
    const line = `${this.ports.now()} ${action} ${outcome}${waited > 0 ? ` wait=${waited}` : ""}`;
    if (defer && this.drives.has(mapPath)) {
      const pending = this.pendingTrace.get(mapPath);
      if (pending?.runId === runId) pending.lines.push(line);
      else this.pendingTrace.set(mapPath, { runId, lines: [line] });
      return;
    }
    await this.writeTrace(mapPath, runId, [line]);
  }
  private async writeTrace(mapPath: string, runId: string, lines: string[]): Promise<void> {
    if (this.disposed) return;
    try {
      await this.ports.mutate(async () => {
        if (this.disposed) return;
        await this.ports.updateMap(mapPath, doc => {
          const data = doc.bookPipeline as { runId?: unknown; gateTrace?: string[] } | undefined;
          if (!data || data.runId !== runId) return;
          data.gateTrace = [...(data.gateTrace ?? []), ...lines].slice(-GATE_TRACE_MAX);
        });
      });
    } catch {
      // the trace never changes what a press did
    }
  }
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
      post: new Set(),
      postWaiters: [],
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
        const left = this.pendingTrace.get(drive.mapPath);
        this.pendingTrace.delete(drive.mapPath);
        if (left) await this.writeTrace(drive.mapPath, left.runId, left.lines);
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
    return neighbourPosition(structure, ownId, otherId);
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
  private planPlaceOf(_drive: Drive, structure: BookStructure, id: string): CardPlanPlace {
    return cardPlanPlaceOf(structure, id);
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
      const lines = this.pendingTrace.get(drive.mapPath);
      await this.ports.updateMap(drive.mapPath, doc => {
        // The gate-press trace is written beside the drive's state: a state write keeps the trace the file has now (not the copy the
        // drive loaded) and carries the applied-press lines that wait for this write.
        const kept = (doc.bookPipeline as { gateTrace?: string[] } | undefined)?.gateTrace;
        const own = lines?.runId === state.runId ? lines.lines : [];
        const trace = [...(kept ?? []), ...own].slice(-GATE_TRACE_MAX);
        doc.bookPipeline = trace.length ? { ...state, gateTrace: trace } : state;
      });
      if (lines && this.pendingTrace.get(drive.mapPath) === lines) this.pendingTrace.delete(drive.mapPath);
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
    if (read.structureUnreadable) this.log(drive, "structure_unreadable", "-", "plan", "left_out");
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
    // Work in its post-write phase does not count against the write pool.
    const writing = (): number => [...inflight.keys()].filter(key => !drive.post.has(key)).length;
    const postDone = (key: string): void => {
      drive.post.delete(key);
      const waiting = drive.postWaiters.splice(0);
      for (const wake of waiting) wake();
    };
    let woken = false;
    let wakeLoop: () => void = () => undefined;
    drive.wake = () => {
      woken = true;
      wakeLoop();
    };
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
      // A card's automatic redo starts once its own first round is over (its proofread committed, its step out of `busy`), not when the whole book is idle.
      if (drive.fixable.size && !drive.job && drive.store.state.status === "running") await this.startFixes(drive);
      await drive.store.commit(state => invalidateStaleAiChapters(state));
      const plan = nextActions(drive.store.state, this.stagesOf(drive), drive.busy, {
        aiProof: !!this.ports.aiProof && !!this.ports.aiFix && !!this.ports.aiBookProof && !drive.job,
        authorPending: new Set(drive.fixable.keys())
      });
      if (plan.hold === "global_failed") drive.failure = drive.reasons.get("global") ?? "failed";
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
          if (drive.post.size >= BOOK_POST_POOL) continue;
          const key = action.nodeId;
          drive.busy.add(key);
          drive.post.add(key);
          started++;
          inflight.set(
            key,
            this.aiChapter(drive, key, action.type === "ai_fix" ? "fix" : "proof").finally(() => {
              drive.busy.delete(key);
              inflight.delete(key);
              postDone(key);
            })
          );
        } else if (action.type === "plan_edit") {
          drive.busy.add(PLAN_EDIT_BUSY);
          started++;
          inflight.set(
            PLAN_EDIT_BUSY,
            this.planEditPass(drive).finally(() => {
              drive.busy.delete(PLAN_EDIT_BUSY);
              inflight.delete(PLAN_EDIT_BUSY);
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
          if (action.type === "card_proof") {
            if (drive.post.size >= BOOK_POST_POOL) continue;
            drive.post.add(key);
          } else if (action.type !== "global_plan" && writing() >= BOOK_POOL) continue;
          drive.busy.add(key);
          started++;
          inflight.set(
            key,
            this.step(drive, action)
              .then(() => undefined)
              .finally(() => {
                drive.busy.delete(key);
                inflight.delete(key);
                postDone(key);
              })
          );
        }
      }
      if (changed && !started) continue;
      if (woken) {
        woken = false;
        continue;
      }
      if (inflight.size) {
        const nudge = new Promise<void>(resolve => (wakeLoop = resolve));
        await Promise.race([...inflight.values(), nudge]);
        wakeLoop = () => undefined;
        woken = false;
      } else if (!started && !changed) break;
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
    if (drive.job || drive.structureBusy || this.dead(drive) || drive.store.state.status !== "running") return false;
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
    if (drive.structureBusy) return false;
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

  // ---- the chief editor's pass over the plans ----------------------------------------------------------------------------------
  /**
   * One call over every card's brief, then the changes it names are written. A failure, a stop or a late result never blocks the book:
   * a stop gives the attempt back (the pass runs again after a resume), the third failure lets the run go on without the pass.
   */
  private async planEditPass(drive: Drive): Promise<void> {
    const begun = await drive.store.commit(state => {
      const dispatched = beginPlanEdit(state);
      return dispatched
        ? { state: dispatched.state, accepted: true, token: dispatched.token }
        : { state, accepted: false as const, token: undefined };
    });
    if (!begun?.accepted || !begun.token) return;
    const token = begun.token;
    const startedAt = Date.parse(this.ports.now());
    const counts = { changes: 0, written: 0, rejected: 0 };
    const out: { opening?: string } = {};
    let outcome: Outcome;
    try {
      outcome = await this.execPlanEdit(drive, token, counts, out);
    } catch (error) {
      outcome = this.classify(drive, error);
    }
    if (this.dead(drive)) return;
    const report = (result: string): void =>
      this.ports.log(
        formatPipelineLog({
          event: "plan_edit",
          runId: token.runId,
          card: "book",
          step: "plan",
          attempt: drive.store.state.planEditAttempts ?? 0,
          result,
          ms: Math.max(0, Date.parse(this.ports.now()) - startedAt || 0),
          counts
        })
      );
    const stopped = (budget: boolean): Promise<unknown> =>
      drive.store.commit(state => applyPlanEditStopped(state, token, budget));
    if (outcome.kind === "ok") {
      const done = await drive.store.commit(state => applyPlanEditSuccess(state, token, out.opening));
      if (!done) return;
      if (!done.accepted) {
        await stopped(false);
        return report("dropped");
      }
      return report("ok");
    }
    if (outcome.kind === "cancelled") {
      await stopped(false);
      return report("cancelled");
    }
    if (outcome.kind === "budget") {
      await stopped(true);
      drive.controller.abort();
      return report("budget");
    }
    const failed = await drive.store.commit(state => applyPlanEditFailure(state, token));
    if (!failed) return;
    if (!failed.accepted) {
      await stopped(false);
      return report("dropped");
    }
    drive.reasons.set("plan-edit", outcome.reason);
    report(`failed:${code(outcome.reason)}`);
  }
  private async execPlanEdit(
    drive: Drive,
    token: PlanEditToken,
    counts: { changes: number; written: number; rejected: number },
    out: { opening?: string }
  ): Promise<Outcome> {
    const signal = drive.controller.signal;
    const rootInfo = drive.cards.get(drive.rootId);
    if (!rootInfo) return { kind: "failed", reason: "missing" };
    const order = effectiveOrder(drive.store.state);
    const structure = this.structureOf(drive, order);
    const root = await this.ports.readCard(rootInfo.path);
    const book = parseBookPlanBody(root.raw);
    const seen = new Map<string, { prompt: string; kind: CardKind; title: string }>();
    const cards: PlanEditCard[] = [];
    // The structure changes of this run that still stand: the chief editor's opening says why the book is shaped as it is.
    const edit = drive.store.state.structureEdit;
    const structureChanges =
      edit && edit.runId === token.runId
        ? edit.applied
            .filter(a => !edit.undone?.includes(a.id))
            .map(a => ({
              kind: a.op.kind,
              title: "title" in a.op ? a.op.title : a.before.title,
              reason: a.op.reason
            }))
        : [];
    for (const id of order) {
      const info = drive.cards.get(id);
      if (!info) return { kind: "failed", reason: "missing" };
      const card = await this.ports.readCard(info.path);
      seen.set(id, { prompt: card.prompt, kind: structure.placeOf(id)?.kind ?? "chapter", title: card.title });
      // A card the program may not rewrite, or one with no plan written by the planner, is not the editor's to change.
      cards.push(
        planEditCardOf(
          id,
          this.placeOf(drive, structure, id),
          info.role,
          card.title,
          card.prompt,
          drive.planSkipped.has(id)
        )
      );
    }
    const request: PlanEditRequest = {
      ...this.base(drive, drive.config.planModel),
      bookTitle: root.title,
      thread: book.thread,
      settings: effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)),
      cards,
      ...(structureChanges.length ? { structureChanges } : {})
    };
    if (!planEditFits(request)) {
      this.log(drive, "plan_refused", "-", "plan", "plans_too_long");
      return { kind: "failed", reason: "plans_too_long" };
    }
    const result = await untilAborted(
      signal,
      this.ports.runPlan(planEditStep, request, { signal, admission: drive.admission })
    );
    const changes = result.changes;
    counts.changes = changes.length;
    const authorize = (): boolean =>
      !this.dead(drive) && !signal.aborted && isPlanEditCurrent(drive.store.state, token);
    const locked = new Set(cards.filter(card => card.locked).map(card => card.id));
    // A change to covers, points or previous without the checklist written for it would leave the old ideas checked. Changes can move a
    // subject from one card to another, so one such change makes the whole reply unusable: nothing is written and the attempt counts.
    counts.rejected = changes.filter(
      change => !locked.has(change.id) && changesBrief(change) && !change.checklist
    ).length;
    if (counts.rejected) return { kind: "failed", reason: "checklist_missing" };
    const done = await writePlanEdits(
      {
        mapPathOf: id => this.stillOnMap(drive, id),
        cardPathOf: id => drive.cards.get(id)?.path,
        readCard: path => this.ports.readCard(path),
        updateNoteGuarded: (path, patch, options) => this.ports.updateNoteGuarded(path, patch, options)
      },
      { changes, seen, locked, structure, ownSummary: drive.ownSummary, language: drive.config.language, authorize }
    );
    counts.written = done.written.length;
    if (done.cancelled) return { kind: "cancelled" };
    out.opening = result.opening;
    return { kind: "ok" };
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
        const failed = await drive.store.commit(state => applyFailure(state, token, outcome.final));
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
  private async aiChapter(
    drive: Drive,
    nodeId: string,
    want: "proof" | "fix",
    rerun = false,
    again = false
  ): Promise<void> {
    const info = drive.cards.get(nodeId);
    if (!info || !this.ports.aiProof || !this.ports.aiFix) return;
    const signal = drive.controller.signal;
    // One unreadable moment (the note is being saved) is not the end of the chapter's check: read once more before giving up.
    const card =
      (await this.ports.readCard(info.path).catch(() => undefined)) ??
      (this.dead(drive) ? undefined : await this.ports.readCard(info.path).catch(() => undefined));
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
    if (card.aiLocked) {
      this.log(drive, "ai_locked_skipped", nodeId, "proof", "ai_locked");
      return giveUp();
    }
    const body = aiProofBody(chapterBody(card.detail));
    const revision = cardRevision(drive.store.state, nodeId);
    const key = aiProofKey(revision, body);
    const stored = drive.store.state.aiProof?.[nodeId];
    if (again && stored?.again && stored.key !== key) {
      // The reader edited the chapter in the middle of the round: the round is closed with the problems it had, nothing is called or written.
      await drive.store.commit(state => ({ state: closeAiRound(state, nodeId), accepted: true }));
      return;
    }
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
      if (!mayRewriteRaw(raw)) {
        // The reader's own text (hand-edited, unknown or kept): no call, nothing is rewritten, every problem is left open.
        const refused = Object.fromEntries(targets.map(target => [target.id, "hand_edited"]));
        const done = await drive.store.commit(current =>
          applyAiFix(current, token, { applied: 0, appliedIds: [], refused })
        );
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
          replacements: replacementsOf(edits, appliedIdsOf(result.outcomes)),
          replacementOf: replacementMapOf(edits, appliedIdsOf(result.outcomes)),
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
  /**
   * The chapters with text in reading order, as the whole-book proofread reads them (prose only), with the program's own findings as hints.
   * A chapter with `ai-locked: true` is marked `locked`: it stays in the list (its text keeps the key), but the calls leave it out, and the
   * hints neither quote it nor count it (they number the chapters the call is sent).
   */
  private async bookProofInput(drive: Drive): Promise<{
    chapters: { id: string; title: string; text: string; raw: string; locked?: true; place?: AiBookChapter["place"] }[];
    hints: string[];
  }> {
    const ordered: (ReferenceChapter & { raw: string; locked?: true; place?: AiBookChapter["place"] })[] = [];
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
        ...(card?.aiLocked ? { locked: true as const } : {}),
        ...(chapter !== undefined ? { chapter } : {}),
        ...(place?.kind === "section" ? { section: true as const } : {}),
        ...(place
          ? {
              place: {
                kind: place.kind,
                ...(chapter !== undefined ? { chapter } : {}),
                ...(place.kind === "section" && place.sectionIndex ? { section: place.sectionIndex } : {})
              }
            }
          : {})
      });
    }
    const chapters = ordered.filter(chapter => chapter.text);
    const sent = chapters.filter(chapter => !chapter.locked);
    const locked = new Set(chapters.filter(chapter => chapter.locked).map(chapter => chapter.id));
    const number = (id: string): string => {
      const at = sent.findIndex(chapter => chapter.id === id);
      return at < 0 ? "?" : String(at + 1);
    };
    const findings = [
      ...chapterReferenceFindings(ordered),
      ...directionFindings(ordered),
      ...numericFindings(chapters, []),
      ...removedChapterRefs(drive.store.state, chapters)
    ].filter(finding => !locked.has(finding.a) && !locked.has(finding.b));
    const hints = findings.map(
      finding =>
        `item ${number(finding.a)}: "${finding.claimA}"; ${
          finding.kind === "removed" ? "names a removed chapter" : `item ${number(finding.b)}`
        }: "${finding.claimB}"${finding.suggestion ? ` (${finding.suggestion})` : ""}`
    );
    return { chapters, hints };
  }

  /**
   * One step of the whole-book AI proofread: the check (the proof model, text only, over every chapter) or the fix (the author model; the
   * edits are applied chapter by chapter, each chapter written once). Same fences as {@link aiChapter}.
   */
  private async aiBook(drive: Drive, want: "proof" | "fix", again = false): Promise<void> {
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
    // ai-flows AI lock: a locked chapter is left out of both calls (not only refused at the write); the key still covers it, so a lock alone
    // does not start the book over. `shown` maps the check's positions back to the book's chapter numbers.
    const shown = chapters.flatMap((chapter, at) => (chapter.locked ? [] : [at]));
    const isLocked = (number: number | undefined): boolean => !!chapters[(number ?? 1) - 1]?.locked;
    const lockedIds = chapters.filter(chapter => chapter.locked).map(chapter => chapter.id);
    // The known problems of a locked chapter stay open (it is not checked again), as long as their quote is still in its text.
    const squash = (text: string): string => text.replace(/\s+/g, "");
    const kept = (): ReturnType<typeof keptForLocked> =>
      keptForLocked(
        drive.store.state.bookProof,
        item =>
          isLocked(item.chapter) && squash(chapters[(item.chapter ?? 1) - 1]?.text ?? "").includes(squash(item.quote))
      );
    if (!shown.length && chapters.length) {
      this.log(drive, "ai_locked_skipped", drive.rootId, "proof", "ai_locked");
      const open = kept();
      await drive.store.commit(state =>
        state.status === "running"
          ? { state: abandonAi(state, undefined, { ids: lockedIds, open }), accepted: true }
          : { state, accepted: false }
      );
      return;
    }
    const joined = (texts: readonly string[]): string => texts.join("\n\u0000\n");
    const key = aiProofKey(0, joined(chapters.map(chapter => chapter.text)));
    const stored = drive.store.state.bookProof;
    const same = stored?.key === key ? stored : undefined;
    const step = same ? want : "proof";
    const begun = await drive.store.commit(state => {
      const dispatched = beginAiStep(state, again ? { rerun: true } : {}, key, step);
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
        const prior = priorOf((same?.pending ?? []).filter(target => !isLocked(target.chapter)));
        const carried = kept();
        const reviewed = await untilAborted(
          signal,
          this.ports.aiBookProof(
            {
              ...this.base(drive, drive.config.proofModel),
              chapters: compactChapters(shown.map(at => ({ title: chapters[at].title, text: chapters[at].text }))).map(
                (chapter, at) => ({
                  ...chapter,
                  ...(chapters[shown[at]].place ? { place: chapters[shown[at]].place } : {})
                })
              ),
              hints,
              ...(prior.length ? { prior } : {})
            },
            run
          )
        );
        if (this.dead(drive)) return;
        const inBook = (number: number): number => (shown[number - 1] ?? number - 1) + 1;
        const review = {
          ...reviewed,
          checks: reviewed.checks.map(check => ({
            ...check,
            ...(check.chapter ? { chapter: inBook(check.chapter) } : {}),
            ...(check.otherChapter ? { otherChapter: inBook(check.otherChapter) } : {})
          }))
        };
        const pending = fixTargetsOf(review.checks);
        const open = review.checks
          .filter(check => checkState(check) === "unfixable")
          .map(check => ({
            id: check.id,
            ...(check.chapter ? { chapter: check.chapter } : {}),
            quote: check.quote,
            problem: check.problem,
            reason: check.why ?? "unfixable"
          }))
          .concat(carried);
        const done = await drive.store.commit(state =>
          applyAiProof(state, token, {
            checked: review.checks.length,
            pending,
            open,
            ...(lockedIds.length ? { locked: lockedIds } : {})
          })
        );
        if (!done?.accepted) {
          await drive.store.commit(state => applyAiStopped(state, token, false));
          return report("dropped");
        }
        return report("ok", { checked: review.checks.length, pending: pending.length, open: open.length });
      }
      // A target in a chapter locked after the check is not asked for (it stays unfixed; the next check leaves that chapter out).
      const targets = (same?.pending ?? []).filter(target => !isLocked(target.chapter));
      const rootInfo = drive.cards.get(drive.rootId);
      const root = rootInfo ? await this.ports.readCard(rootInfo.path).catch(() => undefined) : undefined;
      const range = root
        ? lengthRange(effectiveSettings(root.settings, parseBookPlanDecisions(root.raw)).length)
        : undefined;
      const edits = targets.length
        ? await untilAborted(
            signal,
            this.ports.aiFix(
              {
                ...this.base(drive, drive.config.authorModel),
                chapters: shown.map(at => ({ number: at + 1, title: chapters[at].title, text: chapters[at].text })),
                targets
              },
              run
            )
          )
        : [];
      if (this.dead(drive)) return;
      const refused: Record<string, AiFixRefusal> = {};
      const changed: string[] = [];
      const appliedIds: string[] = [];
      const replacements: string[] = [];
      const replacementOf: Record<string, string> = {};
      const cardOf: Record<string, string> = {};
      let applied = 0;
      let discarded = false;
      const owner = new Map(targets.map(target => [target.id, target.chapter ?? 1]));
      for (let at = 0; at < chapters.length; at++) {
        const mine = targets.filter(target => (target.chapter ?? 1) === at + 1);
        if (!mine.length) continue;
        const chapter = chapters[at];
        if (!mayRewriteRaw(chapter.raw)) {
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
        replacements.push(...replacementsOf(own, appliedIdsOf(result.outcomes)));
        Object.assign(replacementOf, replacementMapOf(own, appliedIdsOf(result.outcomes)));
        for (const id of appliedIdsOf(result.outcomes)) cardOf[id] = chapter.id;
        changed.push(chapter.id);
      }
      let newKey: string | undefined;
      const bodies: Record<string, string> = {};
      if (changed.length) {
        const after = await this.bookProofInput(drive);
        newKey = aiProofKey(0, joined(after.chapters.map(chapter => chapter.text)));
        for (const chapter of after.chapters) if (changed.includes(chapter.id)) bodies[chapter.id] = chapter.text;
      }
      const done = await drive.store.commit(current =>
        applyAiFix(current, token, {
          applied,
          appliedIds,
          replacements,
          replacementOf,
          cardOf,
          refused,
          ...(newKey ? { key: newKey, changed, bodies } : {})
        })
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
      // Left out because AI-locked: each such chapter is named as skipped (locked), not as unfinished; `locked` is the only reason then.
      const locked = state.bookProof.locked ?? [];
      for (const id of locked)
        issues.push({
          source: "ai-proof",
          chapterId: id,
          chapterTitle: title(id),
          problem: "",
          reason: "proof_locked_skipped"
        });
      if (bookProofUnfinished(state.bookProof)) incomplete("");
    }
    for (const id of effectiveOrder(state)) {
      const info = drive.cards.get(id);
      const card = info ? await this.ports.readCard(info.path).catch(() => undefined) : undefined;
      // A placed cover that the program's own check found off its ask: one item of its own, whatever the chapter's stage.
      if (card && coverIsOff(card.raw))
        issues.push({ source: "cover", chapterId: id, chapterTitle: title(id), problem: "", reason: "mismatch" });
      if (drive.stages.get(id) !== "needs-review") continue;
      const issue = String(card?.fields.pipelineIssue ?? "");
      // Only the cover is the reason to look: the cover item above says it, a chapter-status line would be empty.
      if (issue.trim() === `images unmet: ${coverOffToken}`) continue;
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
      // What the status line itself says, once none of the six older causes is: the reason a person can act on (the old fallback was one vague sentence).
      const off = splitPictureIssue(issue).off ?? [...issue.matchAll(/image_(\d+)_mismatch/g)].map(m => Number(m[1]));
      const pictures = openIssuePictures(drive.config.language, off);
      const found =
        reason ||
        (/fix interrupted/.test(issue)
          ? "fix_interrupted"
          : off.length
            ? "image_mismatch"
            : /^proof unmet/.test(issue)
              ? "proof_unmet"
              : /^structure unmet/.test(issue)
                ? "structure_unmet"
                : "");
      issues.push({
        source: "chapter",
        chapterId: id,
        chapterTitle: title(id),
        problem: found === "image_mismatch" ? pictures : "",
        reason: found
      });
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
        // ai-flows AI lock: a page whose only items are chapters skipped as locked is not added (an earlier page of ours is rewritten,
        // so nothing stale stays); the decision is saved for the bar, and a notice names the chapters.
        const locked = drive.store.state.bookProof?.locked ?? [];
        const skipped = !!locked.length && issues.every(issue => issue.reason === "proof_locked_skipped");
        const content = composeOpenIssuesNote({
          bookTitle: root.title,
          language: drive.config.language,
          checked,
          issues
        });
        const folder = root.path.includes("/") ? root.path.slice(0, root.path.lastIndexOf("/")) : "";
        const written = await this.ports.writeOpenIssues(folder, drive.config.language, content, skipped);
        if (!written.ok) continue;
        if (this.dead(drive)) return false;
        await drive.store.commit(state =>
          state.closingSkipped === skipped
            ? { state, accepted: false }
            : { state: { ...state, closingSkipped: skipped, revision: state.revision + 1 }, accepted: true }
        );
        if (skipped) this.ports.lockedSkipped?.(locked.map(id => drive.cards.get(id)?.title ?? ""));
        return true;
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
    const reason = reasonOf(error);
    return { kind: "failed", reason, ...(reason === "bad_request" ? { final: true } : {}) };
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
  private base(drive: Pick<Drive, "config" | "mapPath">, model: string): BookStepBase {
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
   * The one automatic redo (plan 2026 flow v3, E), after that card's own first round: a card whose proofread named unmet points
   * gets its text written again by the author alone (the plan and the checklist stay, attempts are not reset), then proofread once more.
   * The real points go to the author only (never to the proofread). A refused or no longer allowed request leaves the card needs-review.
   * Returns how many cards were sent back; only cards queued by this drive's own proofreads are considered.
   */
  private async startFixes(drive: Drive): Promise<number> {
    let started = 0;
    // A card still in a step (its own proofread result is being written) stays queued for the next round of the loop.
    const queued = [...drive.fixable].filter(([nodeId]) => !drive.busy.has(nodeId));
    for (const [nodeId] of queued) drive.fixable.delete(nodeId);
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
      if (current && !drive.expand.has(nodeId)) this.releasePictures(drive, current);
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
    if (before.aiLocked) {
      this.log(drive, "ai_locked_skipped", drive.rootId, "plan", "ai_locked");
      return { kind: "failed", reason: "ai_locked", final: true };
    }
    const structure = this.structureOf(drive, order);
    const locked = await this.lockedCards(drive, order);
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
          ...(children.length ? { children } : {}),
          ...(locked.has(id) ? { locked: true as const } : {})
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
    // The editor's structure changes are checked on a plain tree first (once per run: a second reply of the same run changes nothing).
    const baseNodes: StructureNode[] = order.map(id => ({
      id,
      parentId: drive.parents.get(id) ?? null,
      title: (drive.cards.get(id) as CardInfo).title
    }));
    const sim =
      result.structure?.length && drive.store.state.structureEdit?.runId !== drive.store.state.runId
        ? simulateStructure({ rootId: drive.rootId, nodes: baseNodes }, result.structure, locked)
        : undefined;
    const titleAfter = this.titleAfter(drive, sim);
    // The section's own heading is added by replaceBookPlanSection; its body (the ### parts) is the composed text after it.
    const sectionWith = (titleOf: (id: string) => string | undefined): string =>
      composeBookPlan(
        {
          thread: result.thread,
          decisions: result.decisions,
          // The owner reads the owning card by its title; the plan view and later card plans work from that title.
          materials: result.materials.map(({ home, ...material }) => {
            const title = home ? titleOf(home) : undefined;
            return title ? { ...material, home: title } : material;
          })
        },
        drive.config.language
      ).replace(/^## .*\n\n?/, "");
    const section = sectionWith(titleAfter);
    const written = await this.ports.updateNoteRawGuarded(path, content => replaceBookPlanSection(content, section), {
      expectedContent: before.raw,
      authorize: this.authorize(drive, token)
    });
    if (written === "discarded") return { kind: "failed", reason: "discarded" };
    if (
      sim &&
      (await this.applyStructure(
        drive,
        token,
        sim,
        baseNodes,
        result.materials,
        path,
        sectionWith(this.titleAfter(drive, undefined))
      )) === "fatal"
    )
      return { kind: "cancelled" };
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

  /** Cards the editor may not remove, merge, move or rename: the owner's hand is in them (and the root). A card that cannot be read now is the owner's too. */
  private async lockedCards(drive: Drive, order: readonly string[]): Promise<Set<string>> {
    const locked = new Set<string>([drive.rootId]);
    for (const id of order) {
      if (id === drive.rootId) continue;
      const info = drive.cards.get(id) as CardInfo;
      const raw = await this.ports.readCard(info.path).then(
        card => (card.aiLocked ? undefined : card.raw),
        () => undefined
      );
      // The text's owner alone: a one-time permit or the card's own rerun opens only that rewrite, never a structure change (the same
      // rule as the chat card's lock).
      if (raw === undefined || !mayRewriteRaw(raw)) locked.add(id);
    }
    return locked;
  }

  /** The title a card has once the proposal is applied (a merged card: its target's; a removed one: none). Without a proposal: as now. */
  private titleAfter(drive: Drive, sim: SimulatedStructure | undefined): (id: string) => string | undefined {
    if (!sim) return id => drive.cards.get(id)?.title;
    const into = new Map(sim.applied.flatMap(a => (a.op.kind === "merge" ? [[a.op.card, a.op.into] as const] : [])));
    const titles = new Map(sim.result.map(n => [n.id, n.title]));
    return id => {
      let cur = id;
      for (let i = 0; into.has(cur) && i < 8; i++) cur = into.get(cur) as string;
      return titles.get(cur);
    };
  }

  /**
   * Writes the editor's changes: one transaction for the notes and Map.md (and `bookPipeline`), then the drive reads the new map. Nothing
   * applied: only the record is saved. A failure leaves everything as it was and the run goes on with the old structure; a failed
   * rollback stops the run ("fatal").
   */
  private async applyStructure(
    drive: Drive,
    token: StepToken,
    sim: SimulatedStructure,
    baseNodes: StructureNode[],
    materials: readonly { name: string; home: string }[],
    rootPath: string,
    plainSection: string
  ): Promise<"done" | "fatal"> {
    const count = (kind: string): number => sim.applied.filter(a => a.op.kind === kind).length;
    this.log(
      drive,
      sim.overCap ? "structure_over_cap" : "structure_edit",
      "-",
      "plan",
      `add:${count("add")},remove:${count("remove")},merge:${count("merge")},move:${count("move")},rename:${count("rename")},rejected:${sim.rejected.length}`
    );
    const runId = drive.store.state.runId;
    const record: StructureEditState = {
      runId,
      applied: [],
      rejected: sim.rejected.map(r => ({ id: r.op.id, code: r.code })),
      ...(sim.overCap ? { overCap: true as const } : {}),
      before: { rootId: drive.rootId, nodes: baseNodes }
    };
    if (!sim.applied.length) {
      if (record.rejected.length || record.overCap)
        await drive.store.commit(state => ({
          state: { ...state, structureEdit: record, revision: state.revision + 1 },
          accepted: true
        }));
      return "done";
    }
    if (!this.ports.editBookStructure) {
      await drive.store.commit(state => ({
        state: { ...state, structureEdit: record, revision: state.revision + 1 },
        accepted: true
      }));
      return "done";
    }
    const { work, next, archived } = this.structureWork(drive, sim, baseNodes, materials, (state, parts) => ({
      ...state,
      order: parts.order,
      accepted: [...parts.order],
      chapters: parts.chapters,
      ...(state.trial ? { trial: parts.trial } : {}),
      structureEdit: { ...record, applied: parts.applied, archived: parts.archived },
      revision: state.revision + 1
    }));
    const outcome = await this.writeStructure(drive, work, next, archived, this.authorize(drive, token));
    if (!outcome.ok) {
      this.log(drive, "structure_failed", "-", "plan", outcome.code);
      if (outcome.rollbackFailed) {
        drive.fatal = new Error("structure_rollback");
        drive.failure = "structure_rollback";
        return "fatal";
      }
      // Nothing was applied (the map is as it was): the materials' homes go back to the cards as they are (the root's plan was written
      // with the merge targets' titles).
      if (sim.applied.some(a => a.op.kind === "merge")) {
        try {
          const now = await this.ports.readCard(rootPath);
          await this.ports.updateNoteRawGuarded(rootPath, content => replaceBookPlanSection(content, plainSection), {
            expectedContent: now.raw,
            authorize: this.authorize(drive, token)
          });
        } catch {
          // the homes keep the merge targets' titles; the plan reads the same
        }
      }
    }
    return "done";
  }

  /**
   * Writes one structure change, the same for the editor's proposal, the chat's change and the undo: the drive is marked structure-busy
   * (a map change it causes is not a reader's), the notes, Map.md and `bookPipeline` go in one transaction in the write queue (`allowed`
   * is asked there), and on success the run state is committed with `next`, the drive reads the new map and the parked notes lose the
   * program's callouts. `parked` is filled by the transaction itself. Returns the transaction's outcome; what a failure means is the
   * caller's.
   */
  private async writeStructure(
    drive: Drive,
    work: StructureWork,
    next: (state: BookPipelineData) => BookPipelineData,
    parked: Readonly<Record<string, string>>,
    allowed: () => boolean
  ): Promise<StructureResult> {
    drive.structureBusy = true;
    try {
      let outcome: StructureResult = { ok: false, code: "cancelled" };
      await this.ports.mutate(async () => {
        if (!allowed()) return;
        outcome = (await this.ports.editBookStructure?.(drive.mapPath, work)) ?? outcome;
      });
      if (!outcome.ok) return outcome;
      await drive.store.commit(state => ({ state: next(state), accepted: true }));
      const map = await this.ports.readMap(drive.mapPath);
      drive.cards.clear();
      drive.stages.clear();
      drive.skippedRefreshed = false;
      await this.load(drive, map, effectiveOrder(drive.store.state), new Set(drive.store.state.autoRoles));
      drive.members = new Set(map.nodes.map(node => node.id));
      const notes = Object.entries(parked).map(([id, path]) => ({ id, path }));
      if (notes.length && this.ports.callouts?.clearNotes)
        await this.ports.callouts.clearNotes(drive.mapPath, drive.store.state.runId, notes).catch(() => false);
      return outcome;
    } finally {
      drive.structureBusy = false;
    }
  }

  /** The one transaction both structure paths write (the notes, Map.md and `bookPipeline`); `compose` makes the new run state from what the edit produced. */
  private structureWork(
    drive: Drive,
    sim: SimulatedStructure,
    baseNodes: StructureNode[],
    materials: readonly { name: string; home: string }[],
    compose: (state: BookPipelineData, parts: StructureParts) => BookPipelineData
  ): { work: StructureWork; next: (state: BookPipelineData) => BookPipelineData; archived: Record<string, string> } {
    const finalTitle = new Map(sim.result.map(n => [n.id, n.title]));
    const oldIds = new Set(baseNodes.map(n => n.id));
    const gone = baseNodes.filter(n => !finalTitle.has(n.id)).map(n => n.id);
    const refs = sim.applied.flatMap(a => (a.op.kind === "add" ? [a.op] : []));
    const idOf = new Map<string, string>();
    const archived: Record<string, string> = {};
    const homesOf = (card: string): string[] => materials.filter(m => m.home === card).map(m => m.name);
    let made: ((state: BookPipelineData) => BookPipelineData) | undefined;
    const work: StructureWork = {
      create: refs.map(op => ({ ref: op.ref, title: finalTitle.get(op.ref) ?? op.title, summary: op.summary })),
      archive: gone.map(id => ({ id, path: (drive.cards.get(id) as CardInfo).path })),
      restore: [],
      rename: baseNodes
        .filter(n => finalTitle.has(n.id) && finalTitle.get(n.id) !== n.title)
        .map(n => ({
          id: n.id,
          path: (drive.cards.get(n.id) as CardInfo).path,
          title: finalTitle.get(n.id) as string
        })),
      edit: (map, tools) => {
        for (const op of refs) idOf.set(op.ref, tools.created(op.ref).id);
        const real = (id: string): string => idOf.get(id) ?? id;
        const byId = new Map(map.nodes.map(node => [node.id, node]));
        const goneSet = new Set(gone);
        const renamed = new Set(
          baseNodes.filter(n => finalTitle.has(n.id) && finalTitle.get(n.id) !== n.title).map(n => n.id)
        );
        const nodes = sim.result.map(item => {
          const id = real(item.id);
          const own = oldIds.has(item.id) ? byId.get(id) : undefined;
          if (oldIds.has(item.id) && !own) throw new Error("card missing from the map");
          const parentId = item.parentId === null ? null : real(item.parentId);
          if (own) return { ...own, parentId, ...(renamed.has(id) ? { path: tools.pathOf(own.path) } : {}) };
          const made = tools.created(item.id);
          return { id: made.id, path: made.path, parentId, x: 0, y: 0, collapsed: false };
        });
        for (const id of gone) {
          const node = byId.get(id);
          if (!node) throw new Error("card missing from the map");
          archived[id] = tools.pathOf(node.path);
        }
        const survivors = new Set(nodes.map(node => node.id));
        if (map.nodes.some(node => !survivors.has(node.id) && !goneSet.has(node.id))) throw new Error("map changed");
        map.nodes = arrangeMap(nodes, undefined, undefined, layoutOf(map));
        const order = bookReadingOrder(map);
        if (order.length !== nodes.length || order.some(id => !survivors.has(id))) throw new Error("order differs");
        const parentOf = new Map(map.nodes.map(node => [node.id, node.parentId]));
        const chapters = Object.fromEntries(
          map.nodes.map(node => [
            node.id,
            { title: finalTitle.get(node.id) ?? drive.cards.get(node.id)?.title ?? "", path: node.path }
          ])
        );
        const fixed = (op: StructureOp): StructureOp => {
          const out: Record<string, unknown> = { ...op };
          for (const key of ["ref", "card", "into", "parent", "after"])
            if (typeof out[key] === "string") out[key] = real(out[key]);
          return out as unknown as StructureOp;
        };
        const applied: AppliedOp[] = sim.applied.map(a => ({
          id: a.id,
          op: fixed(a.op),
          before: {
            parent: a.before.parent === null ? null : real(a.before.parent),
            ...(a.before.after !== undefined ? { after: real(a.before.after) } : {}),
            title: a.before.title,
            ...(a.op.kind === "merge" ? { summary: summaryText(drive.cards.get(a.op.card)?.summary ?? "") } : {}),
            ...(a.op.kind === "merge" && homesOf(a.op.card).length ? { homes: homesOf(a.op.card) } : {})
          }
        }));
        made = state => {
          const trial = bookStructure(order, id => parentOf.get(id), drive.rootId).trialOf();
          const nodes = sim.result.map(item => ({
            id: real(item.id),
            parentId: item.parentId === null ? null : real(item.parentId),
            title: item.title
          }));
          return compose(state, { order, chapters, trial, nodes, applied, archived });
        };
        const kept = (map.bookPipeline as { gateTrace?: string[] } | undefined)?.gateTrace;
        const done = made(drive.store.state);
        map.bookPipeline = kept ? { ...done, gateTrace: kept } : done;
      }
    };
    return { work, next: state => (made as (s: BookPipelineData) => BookPipelineData)(state), archived };
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
    // A kept text the program wrote itself ("accept as it is"): only the card's own rerun (the reader's explicit ask) rewrites it.
    const permit = drive.overwrite.get(nodeId);
    return mayRewriteRaw(raw, {
      rerun: drive.rerun?.nodeId === nodeId,
      permit: permit?.runId === drive.store.state.runId ? permit.fingerprint : undefined
    });
  }

  /** A chapter with `ai-locked: true` (ai-flows, AI lock): no call is made; it needs review with the locked reason, its text untouched. */
  private aiLockedStep(drive: Drive, nodeId: string, step: PipelineStep): Outcome {
    this.log(drive, "ai_locked_skipped", nodeId, step, "ai_locked");
    return { kind: "failed", reason: "ai_locked", forceReview: true };
  }

  private async execPlan(drive: Drive, token: StepToken, nodeId: string): Promise<Outcome> {
    const signal = drive.controller.signal;
    const info = drive.cards.get(nodeId);
    const rootInfo = drive.cards.get(drive.rootId);
    if (!info || !rootInfo) return { kind: "failed", reason: "missing" };
    const card = await this.ports.readCard(info.path);
    if (card.aiLocked) return this.aiLockedStep(drive, nodeId, "plan");
    // The reader's own Summary (a kept chapter, or a card the pipeline never wrote that has text): the plan and the write keep it.
    if (readerSummaryRaw(card.raw)) drive.ownSummary.add(nodeId);
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
    // A section's neighbours are named by title (sections are never numbered, and the previous/next section is a section); the next
    // chapter it leads to is a chapter and keeps its number.
    const side = (id: string | undefined, numbered = kind !== "section"): CardNeighbour | undefined => {
      const other = id === undefined ? undefined : drive.cards.get(id);
      if (!other || id === undefined) return undefined;
      const place = structure.placeOf(id);
      const position = !numbered ? undefined : place?.kind === "preface" ? "preface" : place?.chapter;
      return {
        ...(position === undefined ? {} : { position }),
        title: other.title,
        summary: summaryText(other.summary)
      };
    };
    const previous = side(around.previous);
    const next = side(around.next);
    const nextChapter = side(around.nextChapter, true);
    // The previous card's opening and ending as planned in this run (absent while it is not planned yet): this card must not use the same ones.
    const previousBrief = around.previous === undefined ? undefined : drive.plans.get(around.previous);
    const parentCard = around.parent === undefined ? undefined : drive.cards.get(around.parent);
    const parentChapter = around.parent === undefined ? undefined : structure.placeOf(around.parent)?.chapter;
    const children = this.childCardsOf(drive, nodeId);
    // Cards the editor folded into this one in this run: the plan covers what they said (original title and summary).
    const edit = drive.store.state.structureEdit;
    const merged =
      edit && edit.runId === drive.store.state.runId
        ? edit.applied.flatMap(a =>
            a.op.kind === "merge" && a.op.into === nodeId && !edit.undone?.includes(a.id)
              ? [{ title: a.before.title, summary: a.before.summary ?? "" }]
              : []
          )
        : [];
    const request: CardPlanRequest = {
      ...this.base(drive, drive.config.planModel),
      thread: book.thread,
      settings,
      materials: book.materials,
      chapters: order.flatMap(id => {
        const own = id === nodeId ? card.title : drive.cards.get(id)?.title;
        if (own === undefined) return [];
        const at = structure.placeOf(id)?.kind;
        const summary = summaryText(id === nodeId ? card.summary : (drive.cards.get(id)?.summary ?? "")).trim();
        return [
          {
            place: this.placeOf(drive, structure, id),
            title: own,
            ...(summary && (at === "preface" || at === "chapter") ? { summary } : {})
          }
        ];
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
      ...(previousBrief && (previousBrief.entry || previousBrief.handoff)
        ? { previousStyle: { entry: previousBrief.entry, handoff: previousBrief.handoff } }
        : {}),
      ...(next ? { next } : {}),
      ...(merged.length ? { mergedFrom: merged } : {}),
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
        images: result.images,
        ...(result.cover ? { cover: result.cover } : {})
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
    if (card.aiLocked) return this.aiLockedStep(drive, nodeId, "write");
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
    const finalizeText = (original: string): string | null => {
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
    // The cover block (under the title) is not the author's text: it is taken out before the cleaning and put back under the title after,
    // so neither the tag neutralizing nor the section rules can touch or move it.
    // The cover block (the one directly under the title, as the note has it when this write happens, so an owner edit made while the author
    // worked is kept) is lifted out before the cleaning and put back as it was. The author writes only the Detail, which is never under
    // the title: a cover block in its text is just text and goes through the cleaning (the tag neutralizing) like the rest.
    const finalize = (original: string): string | null => {
      const cover = trustedCoverBlock(original);
      const out = finalizeText(cover === undefined ? original : stripCoverBlock(original));
      return out === null || cover === undefined ? out : putCoverBlock(out, cover);
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
      // The cover block (under the title) is not body text: it is lifted out first and put back as it was, so the rebuild below cannot touch it.
      const cover = trustedCoverBlock(written.raw);
      const bare = cover === undefined ? written.raw : stripCoverBlock(written.raw);
      const held = holdProofLines(bare, knownLines);
      const rebuilt = programStampRaw(bare, held.restore(replaceBodyImages(held.text, replacements)));
      const cleaned = cover === undefined ? rebuilt : putCoverBlock(rebuilt, cover);
      const outcome = await this.ports.updateNoteRawGuarded(path, () => cleaned, {
        expectedContent: written.raw,
        authorize
      });
      if (outcome === "discarded") return { kind: "failed", reason: "discarded" };
    }
    // The author is done: the picture work (search, probes, cover download) runs under its own cap and frees this write's pool place.
    if (!expanding && slots) {
      while (drive.post.size >= BOOK_POST_POOL)
        await untilAborted(signal, new Promise<void>(resolve => drive.postWaiters.push(resolve)));
      drive.post.add(nodeId);
      drive.wake?.();
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

  /** A card's own pictures are free to be picked again: its body pictures and its cover (see {@link coverSourceKey}). */
  private releasePictures(drive: Drive, card: Pick<PipelineCard, "detail" | "raw">): void {
    for (const url of bodyImageUrls(card.detail)) drive.usedImages.delete(imageKey(url));
    const cover = coverSourceKey(card.raw);
    if (cover) drive.usedImages.delete(cover);
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
    const language = drive.config.language;
    const attempt = attemptsOf(drive.store.state, nodeId).write;
    if (!slots) return this.settleStrayMarkers(path, authorize);
    const first = await this.ports.readCard(path);
    const marked = slots.length ? scanSlotMarkers(first.detail, slots).found : new Map<number, number>();
    // The cover ask (plan 2026-11-21-book-cover-image): only a card whose Prompt has the cover line (an older book has none), and only
    // while the cover is not the owner's (a replaced, switched-off or edited cover is never searched for again).
    const coverPlan = parseCardCover(first.prompt);
    const coverHeld = !!coverPlan && coverOwnership(first.raw) === "owner";
    const coverSlot = coverPlan && !coverHeld ? coverAsSlot(coverPlan) : undefined;
    if (coverHeld)
      this.ports.log(
        formatPipelineLog({
          event: "cover_owner_kept",
          runId: token.runId,
          card: nodeId,
          step: "write",
          attempt,
          result: "ok",
          ms: 0
        })
      );
    const others = new Set<string>();
    if (slots.length || coverSlot) {
      // What the other chapters already show (not this card's own old pictures: a rerun may pick again).
      for (const info of drive.cards.values())
        if (info.path !== path) {
          // A card deleted meanwhile is skipped: it must not fail this chapter.
          const other = await this.ports.readCard(info.path).catch(() => undefined);
          if (other) {
            for (const url of bodyImageUrls(other.detail)) others.add(imageKey(url));
            const cover = coverSourceKey(other.raw);
            if (cover) others.add(cover);
          }
        }
    }
    const exclude = [...new Set([...drive.usedImages, ...others])];
    // A work key another chapter of this run claimed is taken; this chapter's own (a rerun) is not.
    const taken = (key: string): boolean =>
      drive.usedImages.has(key) || others.has(key) || (drive.usedWorks.get(key) ?? nodeId) !== nodeId;
    let unfitPlaced = 0;
    let found: PictureSearch;
    try {
      found = await this.searchPictures(drive, first, slots, marked, coverSlot, exclude, taken);
    } catch (error) {
      if (isBudgetExhausted(error)) return { kind: "budget" };
      throw error;
    }
    const {
      perSlot,
      hints,
      drawnDiagrams,
      commonsCut,
      commonsAsked,
      commonsLimited,
      commonsNoHint,
      commonsRejected,
      rounds,
      finderUnfit,
      finderUnchecked,
      finderLookups,
      looks,
      looksUnfit,
      looksDropped,
      looksUnchecked,
      diagramStats
    } = found;
    // Re-read the latest text: the search and the probes took time, and the owner may have edited the card.
    let latest = await this.ports.readCard(path);
    // The card may have left the map while the search and the probes ran: nothing is claimed or written for it.
    if (!(await this.stillOnMap(drive, nodeId))) return { kind: "failed", reason: "card_removed" };
    // Addresses or works refused because this book already shows them (counted for the log).
    const refusedTaken = new Set<string>();
    // The cover is slot 0 and decided first, so it takes its picture before any body slot can; its key is claimed with the rest.
    const outcomes = choosePictures(
      coverSlot ? [coverSlot, ...slots] : slots,
      perSlot,
      key => {
        const used = taken(key);
        if (used) refusedTaken.add(key);
        return used;
      },
      language
    );
    // A slot still not found whose chart passed the checks is filled by the chart (the guarded write refuses a card edited meanwhile).
    for (const [index, diagram] of drawnDiagrams) {
      const outcome = outcomes.get(index);
      if (outcome && "reasonCode" in outcome && outcome.reasonCode === "not_found") outcomes.set(index, { diagram });
    }
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
      const why = offText(slot, outcome.figure, found);
      if (why) off.add(slot.index);
      if (why === "unfit") unfitPlaced++;
    }
    const release = (): void => {
      for (const key of claimed) drive.usedImages.delete(key);
      for (const key of works) drive.usedWorks.delete(key);
    };
    // The cover: download and save its file, then re-read the card (the download took time) before the one write that carries it.
    const coverOutcome = coverSlot ? outcomes.get(COVER_INDEX) : undefined;
    const coverFigure = coverOutcome && "figure" in coverOutcome ? coverOutcome.figure : undefined;
    const coverKey = coverFigure ? imageKey(coverFigure.href) : undefined;
    // A cover claim that ends up on no card is given back so another card may use that picture.
    const releaseCover = (): void => {
      if (coverKey) drive.usedImages.delete(coverKey);
      if (coverFigure?.work && works.includes(coverFigure.work)) drive.usedWorks.delete(coverFigure.work);
    };
    let coverWrite: CoverWrite | undefined;
    let coverResult: "placed" | "missing" | "download_failed" | "owner_kept" | undefined;
    if (coverSlot) {
      try {
        const placed = coverFigure
          ? (perSlot.get(COVER_INDEX) ?? []).find(item => item.href === coverFigure.href)?.candidate
          : undefined;
        const words = askWords({ explains: coverSlot.explains, terms: coverSlot.search, ...hints.get(COVER_INDEX) });
        const coverOff =
          !!placed && words.length > 0 && !wordHits(words, `${placed.title} ${placed.description ?? placed.caption}`);
        const prepared = await this.prepareCover(drive, latest.title, coverFigure, coverOff);
        if (!(await this.stillOnMap(drive, nodeId))) {
          release();
          return { kind: "failed", reason: "card_removed" };
        }
        latest = await this.ports.readCard(path);
        const ownership = coverOwnership(latest.raw);
        if (ownership === "owner") {
          coverResult = "owner_kept";
          releaseCover();
        } else if (prepared.kind === "placed") {
          coverResult = "placed";
          coverWrite = { record: prepared.record, link: prepared.link, source: prepared.source };
        } else {
          coverResult = prepared.kind === "failed" ? "download_failed" : "missing";
          releaseCover();
          // A cover the program placed earlier stays when this run finds none (a flaky search must not take a good cover away).
          if (ownership === "none") coverWrite = { record: { missing: 1 } };
        }
      } catch (error) {
        release();
        throw error;
      }
    }
    try {
      const bodyOutcomes = new Map([...outcomes].filter(([index]) => index !== COVER_INDEX));
      const result = await this.writeFilled(latest, slots, bodyOutcomes, language, authorize, off, coverWrite);
      if (typeof result === "string") {
        release();
        return { kind: "failed", reason: result };
      }
      // The owner took the cover over between the re-read and the write: nothing was written for it, so its claim is given back.
      if (coverWrite?.held) {
        coverResult = "owner_kept";
        releaseCover();
      }
      if (coverResult)
        this.ports.log(
          formatPipelineLog({
            event: `cover_${coverResult}`,
            runId: token.runId,
            card: nodeId,
            step: "write",
            attempt,
            result: "ok",
            ms: 0
          })
        );
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
            ...(finderLookups ? { finder_lookup: finderLookups } : {}),
            ...(finderUnfit ? { finder_unfit: finderUnfit } : {}),
            ...(unfitPlaced ? { finder_unfit_placed: unfitPlaced } : {}),
            ...(finderUnchecked ? { finder_unchecked: finderUnchecked } : {}),
            ...(looks ? { look: looks } : {}),
            ...(looksUnfit ? { look_unfit: looksUnfit } : {}),
            ...(looksDropped ? { look_dropped: looksDropped } : {}),
            ...(looksUnchecked.size ? { look_unchecked: looksUnchecked.size } : {}),
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
            ...(diagramStats.asked
              ? {
                  diagram_asked: diagramStats.asked,
                  diagram_drawn: result.diagrams?.length ?? 0,
                  diagram_declined:
                    diagramStats.asked -
                    drawnDiagrams.size -
                    Object.values(diagramStats.rejected).reduce((a, b) => a + b, 0)
                }
              : {}),
            ...Object.fromEntries(Object.entries(diagramStats.rejected).map(([code, n]) => [`diagram_rej_${code}`, n])),
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

  /**
   * The picture search of one chapter's slots (the fill's, and a refind's of one slot): the finder search (a second one for the slots
   * still lacking), the fit test of its Commons files, the probes, the look at its other pictures, the program's Commons search and the
   * last resort, then the diagram call (off with `draw: false`). Nothing is claimed or written here; a budget or Stop error is thrown.
   * `again` sends the first finder search as a repeat (a refind asks for another picture than the one shown).
   */
  private async searchPictures(
    drive: PictureJob,
    first: PipelineCard,
    slots: ImageSlot[],
    marked: ReadonlyMap<number, number>,
    coverSlot: ImageSlot | undefined,
    exclude: string[],
    taken: (key: string) => boolean,
    options: { again?: boolean; draw?: boolean } = {}
  ): Promise<PictureSearch> {
    const signal = drive.controller.signal;
    const language = drive.config.language;
    const wanted = slots.filter(slot => marked.has(slot.index));
    // The cover rides in the first search (after the body slots, so the probe limit never takes a body picture's place); it is never asked again.
    const asked = coverSlot ? [...wanted, coverSlot] : wanted;
    // Only Wikimedia upload addresses can be a cover (they are the only ones downloaded): the rest is dropped before anything is probed or chosen.
    const coverOnly = (from: FoundImages | undefined): FoundImages | undefined =>
      from && coverSlot
        ? {
            ...from,
            bySlot: new Map(
              [...from.bySlot].map(([index, list]) => [index, index === COVER_INDEX ? coverCandidates(list) : list])
            )
          }
        : from;
    // One search call for `list`; a failed or timed-out call is an optional gain lost (undefined), never a failure of the chapter.
    const search = async (
      list: ImageSlot[],
      again: boolean,
      avoid: readonly string[]
    ): Promise<FoundImages | undefined> => {
      if (!list.length || !this.ports.findImages) return undefined;
      searchesAsked++;
      try {
        const answer = await untilAborted(
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
        if (answer) searchesAnswered++;
        return answer;
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
    const hints = new Map<number, { subject?: string; search?: string }>();
    const keepHints = (from: FoundImages | undefined): void => {
      for (const [index, hint] of from?.hints ?? []) hints.set(index, { ...hints.get(index), ...hint });
    };
    let commonsAsked = 0;
    let searchesAsked = 0;
    let searchesAnswered = 0;
    let commonsLimited = false;
    const commonsCut = new Set<number>();
    let commonsNoHint = 0;
    let commonsRejected: Partial<Record<CommonsRejection, number>> = {};
    const rounds: (FoundImages | undefined)[] = [];
    let finderUnfit = 0;
    let finderUnchecked = 0;
    let finderLookups = 0;
    const unfitKeys = new Set<string>();
    // The finder's body-slot pictures go through the same fit test as the program's own Commons search, on the file page's title,
    // description and categories (one request per chapter and search). An unfit one is not dropped (word matching also refuses correct
    // pictures): it is held back here, so its slot still counts as lacking for the second search and the Commons search, and it is placed
    // only when nothing else turned up, recorded as off its text. What cannot be checked is kept as it was. The cover is not touched.
    const heldUnfit = new Map<number, FoundImage[]>();
    // A diagram-kind slot's picture the look step refused stays held (so the searches skip it) but is not the last resort while the
    // diagram step will be asked for the slot: it stays not found and the step draws it. If no drawing will happen it is placed, off. Keys are `${slot}|${url}`.
    const noLastResort = new Set<string>();
    const drawnDiagrams = new Map<number, SlotDiagram>();
    const diagramStats = { asked: 0, drawn: 0, rejected: {} as Record<string, number> };
    const fitFound = async (from: FoundImages | undefined): Promise<FoundImages | undefined> => {
      const fetchCommons = this.ports.fetchCommons;
      if (!from || !fetchCommons) return from;
      const slotOf = (index: number): CommonsSlot | undefined => {
        const slot = slots.find(item => item.index === index);
        return slot
          ? {
              index,
              kind: slot.kind,
              explains: slot.explains,
              ...(slot.search?.length ? { terms: slot.search } : {}),
              ...hints.get(index)
            }
          : undefined;
      };
      const names = [...from.bySlot]
        .filter(([index]) => index !== COVER_INDEX)
        .flatMap(([index, list]) => (slotOf(index) && slotCanBeChecked(slotOf(index)!) ? list : []))
        .flatMap(item => commonsFileNameOf(item.source) ?? []);
      const found = await lookupCommonsFiles(names, fetchCommons, {
        signal,
        run: drive.commonsBudget,
        now: () => Date.parse(this.ports.now()),
        ...(this.ports.commonsQueue ? { queue: this.ports.commonsQueue } : {})
      });
      finderLookups += found.requests;
      const bySlot = new Map<number, FoundImage[]>();
      for (const [index, list] of from.bySlot) {
        const slot = index === COVER_INDEX ? undefined : slotOf(index);
        const kept: FoundImage[] = [];
        for (const item of list) {
          const name = commonsFileNameOf(item.source);
          const page = slot && slotCanBeChecked(slot) && name ? commonsInfoFor(found.info, name) : undefined;
          if (!page) {
            if (slot) finderUnchecked++;
            kept.push(item);
          } else {
            const checked = {
              ...item,
              description: [page.description, page.categories].filter(Boolean).join(" · ").slice(0, 300)
            };
            if (!unfitSlot(slot!, `${page.title} ${page.description} ${page.categories}`)) kept.push(checked);
            else {
              finderUnfit++;
              const held = heldUnfit.get(index) ?? [];
              if (!held.some(have => have.url === checked.url)) heldUnfit.set(index, [...held, checked]);
            }
          }
        }
        bySlot.set(index, kept);
      }
      return { ...from, bySlot };
    };
    // Each loadable non-Commons body candidate (at most LOOKS_PER_CHAPTER a chapter, over both searches) is downloaded by the program (never saved)
    // and looked at by one AI call: it fits (its caption becomes what the call saw) or it is held back like an unfit Commons file. A picture that
    // cannot be fetched is dropped without a call; a call that fails leaves the candidate unlooked. Beyond the limit a candidate stays unchecked.
    const lookedAt = new Set<string>();
    const lookedFit = new Set<string>();
    let looks = 0;
    let looksUnfit = 0;
    let looksDropped = 0;
    const looksUnchecked = new Set<string>();
    // A slot that already has its pick (a Commons picture ahead, or a candidate the AI said fits) stays settled in later rounds: nothing after it is looked at.
    const settledSlots = new Set<number>();
    const lookRound = async (): Promise<void> => {
      const ports = this.ports;
      if (!ports.lookAtImage || !ports.fetchPicture) return;
      for (const slot of slots) {
        const list = perSlot.get(slot.index);
        if (!list) continue;
        const kept: ProbedCandidate[] = [];
        let settled = settledSlots.has(slot.index);
        for (const item of list) {
          const { candidate, href } = item;
          if (settled || !href || !item.loaded || lookedAt.has(href) || taken(imageKey(href))) {
            kept.push(item);
            continue;
          }
          if (isCommonsCandidate(candidate)) {
            // A Commons picture ahead of the others is the slot's pick: nothing after it is looked at.
            settled = true;
            settledSlots.add(slot.index);
            kept.push(item);
            continue;
          }
          if (looks >= LOOKS_PER_CHAPTER) {
            looksUnchecked.add(href);
            kept.push(item);
            continue;
          }
          lookedAt.add(href);
          const dataUrl = await untilAborted(signal, ports.fetchPicture(href, drive.config.imageModel, signal)).catch(
            (error: unknown) => {
              if (signal.aborted) throw error;
              return undefined;
            }
          );
          if (signal.aborted) throw new Error("aborted");
          if (!dataUrl) {
            looksDropped++;
            continue;
          }
          looks++;
          let fit: ImageFit | undefined;
          try {
            fit = await untilAborted(
              signal,
              ports.lookAtImage(
                {
                  ...this.base(drive, drive.config.imageModel),
                  chapter: imageSearchText(first),
                  kind: slot.kind,
                  explains: slot.explains,
                  imageDataUrl: dataUrl
                },
                { signal, admission: drive.admission }
              )
            );
          } catch (error) {
            if (isBudgetExhausted(error) || signal.aborted) throw error;
          }
          if (signal.aborted) throw new Error("aborted");
          if (!fit) {
            looksUnchecked.add(href);
            kept.push(item);
          } else if (fit.fits) {
            settled = true;
            settledSlots.add(slot.index);
            lookedFit.add(`${slot.index}|${candidate.imageUrl}`);
            kept.push(fit.caption ? { ...item, candidate: { ...candidate, caption: fit.caption } } : item);
          } else {
            looksUnfit++;
            if (isDiagramKind(slot.kind)) noLastResort.add(`${slot.index}|${candidate.imageUrl}`);
            const held = heldUnfit.get(slot.index) ?? [];
            if (!held.some(have => have.url === candidate.imageUrl))
              heldUnfit.set(slot.index, [
                ...held,
                {
                  url: candidate.imageUrl,
                  source: candidate.sourceUrl,
                  title: candidate.title,
                  caption: candidate.caption,
                  ...(candidate.description !== undefined ? { description: candidate.description } : {}),
                  ...(candidate.author ? { author: candidate.author } : {}),
                  ...(candidate.license ? { license: candidate.license } : {})
                }
              ]);
          }
        }
        perSlot.set(slot.index, kept);
      }
    };
    const round1 = await search(asked, options.again ?? false, exclude);
    rounds.push(round1);
    keepHints(round1);
    const fit1 = await fitFound(round1);
    for (const [index, list] of await probeFound(asked, coverOnly(fit1))) perSlot.set(index, list);
    await lookRound();
    // A second search (once) for the slots the first one left without a usable picture: another direction, the tried addresses excluded.
    if (round1) {
      const provisional = choosePictures(slots, perSlot, taken, language);
      const lacking = wanted.filter(slot => !("figure" in (provisional.get(slot.index) ?? {})));
      const tried = [
        ...new Set([
          ...[...perSlot.values()].flatMap(list => list.map(item => imageKey(item.candidate.imageUrl))),
          ...[...heldUnfit.values()].flatMap(list => list.map(item => imageKey(item.url)))
        ])
      ];
      const second = await search(lacking, true, [...tried, ...exclude]);
      rounds.push(second);
      keepHints(second);
      if (second) {
        for (const [index, list] of await probeFound(lacking, await fitFound(second)))
          perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
        await lookRound();
      }
    }
    // The program's own search (no model call) for the slots still without a usable picture: Wikimedia Commons, bounded per slot and
    // per chapter; its candidates are probed, deduped and chosen like the finder's.
    if (this.ports.fetchCommons) {
      const provisional = choosePictures(coverSlot ? [coverSlot, ...slots] : slots, perSlot, taken, language);
      // The cover is the last one asked of Commons, so it never takes a body picture's share of the chapter's requests.
      const lacking = asked.filter(slot => !("figure" in (provisional.get(slot.index) ?? {})));
      if (lacking.length) {
        const seen = new Set([
          ...exclude,
          ...[...perSlot.values()].flatMap(list => list.map(item => imageKey(item.candidate.imageUrl))),
          ...[...heldUnfit.values()].flatMap(list => list.map(item => imageKey(item.url)))
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
        searchesAsked += commons.requests;
        searchesAnswered += commons.answered;
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
        for (const [index, list] of await probeFound(lacking, coverOnly(asFound) ?? asFound))
          perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
      }
    }
    // Last resort: a slot still without a usable picture takes the finder's unfit one (probed now, placed last, recorded off).
    const canDraw = options.draw !== false && !!this.ports.drawDiagrams && (this.ports.diagramsOn?.() ?? true);
    if (heldUnfit.size) {
      const provisional = choosePictures(slots, perSlot, taken, language);
      const usable = new Map<number, FoundImage[]>();
      for (const [index, list] of heldUnfit) {
        // Held back from the last resort only when the diagram step will really be asked for this slot; otherwise it is placed, off.
        const willDraw = canDraw && marked.has(index) && !commonsCut.has(index);
        const kept = willDraw ? list.filter(item => !noLastResort.has(`${index}|${item.url}`)) : list;
        if (kept.length) usable.set(index, kept);
      }
      const last = slots.filter(slot => usable.has(slot.index) && !("figure" in (provisional.get(slot.index) ?? {})));
      const asHeld: FoundImages = { bySlot: usable, found: 0, offTopic: 0 };
      for (const [index, list] of await probeFound(last, asHeld)) {
        for (const item of usable.get(index) ?? []) unfitKeys.add(`${index}|${item.url}`);
        perSlot.set(index, [...(perSlot.get(index) ?? []), ...list]);
      }
    }
    // Diagram-kind slots still without a picture get one extra call (a chart drawn from the chapter text), never one per slot.
    if (this.ports.drawDiagrams && canDraw) {
      const provisional = choosePictures(slots, perSlot, taken, language);
      const want = slots.filter(slot => {
        const outcome = provisional.get(slot.index);
        return (
          marked.has(slot.index) &&
          !commonsCut.has(slot.index) &&
          isDiagramKind(slot.kind) &&
          !!outcome &&
          "reasonCode" in outcome &&
          outcome.reasonCode === "not_found"
        );
      });
      if (want.length) {
        diagramStats.asked = want.length;
        const text = stripImageLines(chapterBody(first.detail));
        // A figure already in the chapter (maybe hand-edited) is not a source of numbers for the checks.
        const checkText = stripFigureFences(text);
        let drafts: DiagramDraft[] = [];
        try {
          drafts = await untilAborted(
            signal,
            this.ports.drawDiagrams(
              {
                ...this.base(drive, drive.config.authorModel),
                chapter: text,
                slots: want.map(({ index, kind, explains }) => ({ index, kind, explains }))
              },
              { signal, admission: drive.admission }
            )
          );
        } catch (error) {
          if (isBudgetExhausted(error) || signal.aborted) throw error;
        }
        for (const draft of drafts) {
          const slot = want.find(item => item.index === draft.slot);
          if (!slot) continue;
          if (draft.mermaid === undefined) {
            const figure = checkFigureDraft(draft, checkText);
            let figureCode: string | undefined = figure.ok ? undefined : figure.code;
            const figureTitle = diagramTitle(draft.title, slot.explains, language);
            if (
              figure.ok &&
              this.exitCheck(
                ["```vam-figure", figure.body, "```", "", diagramCaption(figureTitle, language)].join("\n"),
                new Set()
              )
            )
              figureCode = "unsafe";
            if (figureCode || !figure.ok) {
              diagramStats.rejected[figureCode ?? "unsafe"] = (diagramStats.rejected[figureCode ?? "unsafe"] ?? 0) + 1;
              continue;
            }
            drawnDiagrams.set(slot.index, { title: figureTitle, mermaid: figure.body, fence: "vam-figure" });
            continue;
          }
          const checked = checkDiagram(draft, checkText);
          let code: string | undefined = checked.ok ? undefined : checked.code;
          let title = "";
          if (checked.ok) {
            title = diagramTitle(draft.title, slot.explains, language);
            const lines = ["```mermaid", checked.mermaid, "```", "", diagramCaption(title, language)].join("\n");
            // The fill's exit check refuses a whole chapter for one such line, so a chart it would refuse is dropped alone here.
            if (this.exitCheck(lines, new Set())) code = "unsafe";
            else if (this.ports.mermaidSyntax) {
              const verdict = await untilAborted(signal, this.ports.mermaidSyntax(checked.mermaid));
              if (verdict === "invalid") code = "syntax";
            }
          }
          if (code || !checked.ok) {
            diagramStats.rejected[code ?? "unsafe"] = (diagramStats.rejected[code ?? "unsafe"] ?? 0) + 1;
            continue;
          }
          drawnDiagrams.set(slot.index, { title, mermaid: checked.mermaid });
        }
        diagramStats.drawn = drawnDiagrams.size;
      }
    }
    return {
      perSlot,
      hints,
      unfitKeys,
      lookedFit,
      drawnDiagrams,
      commonsCut,
      commonsAsked,
      searchesAsked,
      searchesAnswered,
      commonsLimited,
      commonsNoHint,
      commonsRejected,
      rounds,
      finderUnfit,
      finderUnchecked,
      finderLookups,
      looks,
      looksUnfit,
      looksDropped,
      looksUnchecked,
      diagramStats
    };
  }

  /**
   * Downloads the chosen cover (one at a time through the Commons queue, so Wikimedia sees one request a second at most), saves its file in
   * the book's cover folder and builds its record and credit. `missing`: nothing was chosen; `failed`: the picture could not be downloaded or saved;
   * a stop or timeout of the run throws like any other step. Nothing is written to the note here.
   */
  private async prepareCover(
    drive: Drive,
    title: string,
    figure: SlotFigure | undefined,
    off: boolean
  ): Promise<
    | { kind: "placed"; record: CoverRecordValue; link: string; source: { href: string; entry: string } }
    | { kind: "missing" }
    | { kind: "failed" }
  > {
    if (!figure) return { kind: "missing" };
    const signal = drive.controller.signal;
    const ports = this.ports;
    if (!ports.fetchCoverImage || !ports.saveCover) return { kind: "failed" };
    const queue = this.ports.commonsQueue ?? commonsQueue;
    const download = await untilAborted(
      signal,
      queue.turn(
        () => signal.aborted,
        async () => ports.fetchCoverImage?.(figure.href, signal)
      )
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    });
    if (signal.aborted || (download && !download.ok && download.reason === "aborted")) throw new Error("aborted");
    if (!download?.ok) return { kind: "failed" };
    const root = drive.cards.get(drive.rootId);
    const book = root && root.path.includes("/") ? root.path.slice(0, root.path.lastIndexOf("/")) : "";
    const folder = [book, coverFolderName(drive.config.language)].filter(Boolean).join("/");
    const saved = await untilAborted(
      signal,
      ports.saveCover?.(folder, title, figure.href, download, signal) ?? Promise.resolve(undefined)
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      return undefined;
    });
    if (signal.aborted || (saved && !saved.ok && saved.reason === "aborted")) throw new Error("aborted");
    if (!saved?.ok) return { kind: "failed" };
    // The caption is the finder's own plain sentence: one that only names the file, or is in another script than the book, is left out.
    let caption = unescapeMarkdownText(figure.caption);
    const wrongScript = /^zh/i.test(drive.config.language) && !/[\u3400-\u9fff]/.test(caption);
    if (
      wrongScript ||
      captionIsFileName(caption, figure.href) ||
      captionLatinIssue(`![](x)\n${caption}`, drive.config.language)
    )
      caption = "";
    // Only a Commons file page can be the cover's credit; a picture without one is treated as not found.
    const href = commonsFilePage(figure.source?.href ?? "");
    const entry = figure.source?.coverEntry;
    const file = coverLinkOf(saved.path);
    if (!href || !entry || !file) return { kind: "missing" };
    return {
      kind: "placed",
      record: {
        file,
        key: imageKey(figure.href),
        ...(caption ? { caption: caption.slice(0, 200) } : {}),
        source: href,
        ...(off ? { off: 1 } : {})
      },
      link: file,
      source: { href, entry }
    };
  }

  /** One probe through the run-wide gate: true when the picture loads. A probe that throws (not a Stop) counts as not loaded. */
  private async probeGated(drive: Pick<Drive, "controller" | "probeGate">, href: string): Promise<boolean> {
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
    off?: ReadonlySet<number>,
    cover?: CoverWrite
  ): Promise<FillResult | string> {
    const result = fillSlotMarkers(latest.detail, slots, outcomes, language);
    const bad = verifyFill(latest.detail, result, slots);
    if (bad) return `slots_${bad}`;
    // The exit check: nothing but the placed addresses may be an image in what this write adds.
    if (this.exitCheck(result.added.join("\n"), new Set(result.placed.map(item => item.href)))) return "slots_unsafe";
    // A new cover replaces the credit line of the one it replaces (the card's cover has one credit).
    const oldSource = cover?.source ? readCoverRecord(latest.raw)?.source : undefined;
    const withSources = addPictureSources(
      oldSource && oldSource !== cover?.source?.href
        ? removeCoverCredit(result.text, oldSource, language)
        : result.text,
      cover?.source ? [...result.sources, cover.source] : result.sources,
      language
    );
    const slotted = slots.length ? replaceResearchRecord(withSources, composeSlotsRecord(result, off)) : withSources;
    // The slot fill is the program's own change of the text: its fingerprint follows only if the text it started from still had it.
    const detail = programStamp(latest.detail, slotted);
    if (detail === latest.detail && !cover) return result;
    const outside = residualMarkerLines(latest.raw).length - residualMarkerLines(latest.detail).length;
    const outcome = await this.ports.updateNoteGuarded(
      latest.path,
      { detail },
      {
        expectedContent: latest.raw,
        authorize,
        finalize: content => {
          if (residualMarkerLines(content).length > Math.max(0, outside)) return null;
          // The cover record, its credit and `topic-cover` go in the same write; a cover the owner took over meanwhile is left alone.
          if (!cover) return content;
          if (coverOwnership(content) === "owner") {
            cover.held = true;
            return content;
          }
          const placed = placeCover(content, cover.record);
          // `topic-cover` that already links this file is left as it is, so the owner's frame, size and position settings are kept.
          return cover.link && coverDeclaredTarget(placed) !== cover.link && this.ports.setCoverLink
            ? this.ports.setCoverLink(placed, cover.link)
            : placed;
        }
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
    if (card.aiLocked) return this.aiLockedStep(drive, nodeId, "proof");
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
      ...(minimum !== undefined && imageCheck.placed + imageCheck.diagrams < minimum
        ? [pictureShortfallToken(imageCheck.placed + imageCheck.diagrams, minimum)]
        : []),
      ...(limited ? [PICTURE_LIMITED_TOKEN] : []),
      ...(offIndexes.length ? [pictureMismatchToken(offIndexes)] : []),
      // The cover is not a counted picture, but a cover the block itself says may not fit is a reason to look too.
      ...(coverIsOff(card.raw) ? [coverOffToken] : []),
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
  ): Promise<{ title: string; covers: string; entry?: string; current?: boolean }[]> {
    const ids = effectiveOrder(drive.store.state).filter(id => drive.cards.has(id));
    const chapters: { title: string; covers: string; entry?: string }[] = await this.proofChapters(
      drive,
      nodeId,
      card,
      true
    );
    return chapters.map((chapter, at) => (ids[at] === nodeId ? { ...chapter, current: true } : chapter));
  }

  /** The book's chapters in reading order for the proofread: each title and its Prompt's covers line (an unreadable card keeps its title only). */
  private async proofChapters(
    drive: Drive,
    nodeId: string,
    card: { title: string; prompt: string },
    withEntry = false
  ): Promise<{ title: string; covers: string; entry?: string }[]> {
    const chapters: { title: string; covers: string; entry?: string }[] = [];
    for (const id of effectiveOrder(drive.store.state)) {
      const info = drive.cards.get(id);
      if (!info) continue;
      const other = id === nodeId ? card : await this.ports.readCard(info.path).catch(() => undefined);
      const covers = other ? (parseCardPrompt(other.prompt).covers ?? "") : "";
      const entry =
        withEntry && other ? singleLineText(parseCardPrompt(other.prompt).entry ?? "", PROOF_COVERS_MAX) : "";
      chapters.push({
        title: other?.title ?? info.title,
        covers: singleLineText(covers, PROOF_COVERS_MAX),
        ...(entry ? { entry } : {})
      });
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
      ...(active && drive.again ? { again: { ...drive.again } } : {}),
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
      // A needs-review card whose automatic redo is queued is not done yet.
      return planning
        ? stage === undefined
        : (stage !== "checked" && stage !== "needs-review") || drive.fixable.has(id);
    }).length;
    const average = list.reduce((sum, ms) => sum + ms, 0) / list.length;
    // Planning runs BOOK_POOL cards at once; writing has cards in both the write and the post-write places.
    const atOnce = planning ? BOOK_POOL : BOOK_POOL + BOOK_POST_POOL;
    return Math.max(0, Math.round((average * left) / atOnce / 1000));
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
