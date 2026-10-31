import {
  defaultOutputLanguage,
  existingNoteLanguage,
  mapChatLanguageSources,
  outputLanguageForMap,
  rememberedOutputLanguage,
  resolveAimContentLanguage
} from "../aim/content-language";
import {
  addImage,
  boundaryBounds,
  moveItem,
  pruneBoundaries,
  removeItem,
  resizeKeepRatio,
  IMAGE_MIN_SIZE,
  type BoundaryItem,
  type CanvasItem,
  type ImageItem
} from "./canvas-items";
import { acceptImage, imageFilesFrom, imageSize, safeImageName, sniffImage, IMAGE_MAX_BYTES } from "./image-input";
import {
  EXPORT_MAX_EDGE,
  EXPORT_MAX_EMBEDDED_BYTES,
  EXPORT_MAX_PIXELS,
  browserPngEnv,
  buildMapSvg,
  exportFileStem,
  exportLimits,
  mapOutline,
  normalizeCssColor,
  svgToPngBlob,
  toDataUri,
  wrapText,
  type MapScene,
  type SceneBoundary,
  type SceneCard,
  type SceneEdge,
  type SceneImage
} from "./map-export";
import { buildMapSearchBar, searchMap, stepSearch, type MapSearchBar, type MapSearchResult } from "./map-search-bar";
import { collapsedAncestors } from "./map-search";
import {
  classifyPresentationKey,
  moveInOrder,
  reconcileCurrent,
  startingId,
  type PresentationAction,
  type PresentationState
} from "./presentation-mode";
import { readingOrder } from "./presentation-order";
import { resolveMapTextLanguage, synthesisDefaultName } from "./map-text-language";
import {
  begin as beginTransaction,
  isTransactionError,
  type AttachmentPath,
  type Transaction,
  type TransactionEntry
} from "./map-transaction";
import { backgroundResultNotice, renderBackgroundStatus } from "../../ui/background-run";
import { PromptPresetsModal } from "../../ui/modals/prompt-presets-modal";
import { AimClarificationModal } from "../../ui/modals/aim-clarification-modal";
import { withThinkingOrigin } from "./thinking-origin";
import {
  fishboneSpinePathData,
  relationLabelPoint,
  relationPathData,
  treeEdgePathData,
  type RelationBox
} from "./relation-geometry";
import { TOPIC_MARKERS, markerLabelKey, markerSymbol, type TopicMarker } from "../../topic-markers";
import { TOPIC_COLORS, branchNoteIds, colorLabelKey, type TopicColor } from "../../topic-colors";
import { appendImageEmbed, resolveCover, withCover, withCoverOff, withoutCover } from "./card-cover";
import { TOPIC_KIND_SHAPES, hasSvgShape, renderShapeBackground, shapeInsets } from "./topic-kind-shape";
import { createHash, randomUUID } from "node:crypto";
import type VisualAgentMapPlugin from "../../main";
import {
  noteLanguageOf,
  t,
  topicStatusLabel,
  translateNote,
  type TranslationKey,
  type ContentLanguage
} from "../../i18n";
import {
  MarkdownRenderer,
  ItemView,
  type Editor,
  Menu,
  Modal,
  MarkdownView,
  Notice,
  Scope,
  TFile,
  WorkspaceLeaf,
  setIcon,
  setTooltip
} from "obsidian";
import { readMarkdownFile, type ReferenceGroup } from "../../ai/reference-materials";
import { providerForModel } from "../../ai/providers/provider";
import { classifyProviderError, otherProviderModel, providerOfFailure } from "../../ai/provider-error";
import { FALLBACK_MODEL, resolveTaskModel, type ModelChoice } from "../../ai/model-resolution";
import { NameModal } from "../../ui/modals/name-modal";
import { sanitizeGeneratedTitle } from "../../core/title-safety";
import { ChoiceModal } from "../../ui/modals/choice-modal";
import {
  applyCollapseLevel,
  canParent,
  clearQuestionConvergenceEdges,
  repairAimResultConvergence,
  clone,
  descendants,
  History,
  inheritModel,
  legalRelationTargets,
  type MapDocument,
  type MapNode,
  normalizeRelationDescription,
  RELATION_DESCRIPTION_MAX_LENGTH,
  parentIdsForNode,
  removeNodes,
  removeTopicRelationsFor,
  relationAllowed,
  retargetTopicRelations,
  setTopicRelations,
  supersededAimNodeIds,
  type TopicRelation,
  type TopicRelationKind,
  visibleNodes
} from "../../map-model";
import { CARD_WIDTH, CARD_WIDTH_MAX, CARD_WIDTH_MIN, CARD_WIDTH_STEP, clampCardWidth } from "../../map-graph";
import {
  arrangeMap,
  arrangeNewBranch,
  arrangeNewTree,
  DEFAULT_CARD_HEIGHT,
  LAYOUT_GAP,
  layoutDirectionFor,
  layoutOf,
  medianHeight,
  reorderTopLevel,
  type LayoutKind,
  type LayoutSpacing
} from "../../map-layout";
import { neighborKey, type NavigationSide } from "../../layouts/navigation";
import { allowsBranchLayout, branchDirectionOf, cleanBranchLayouts, type BranchDirection } from "../../layouts/compose";
import { inLanguage, NONE } from "../../core/steps/_shared/fragments";
import { mergeRepair } from "../../core/steps/task/fragments";
import { checkMergePreservation, findingList, type MergeCheckResult } from "../../core/steps/task/merge-check";
import { carryForwardSources } from "../../core/steps/task/carry-sources";
import {
  expansionTask,
  labelCurrentSummary,
  labelFullKnowledge,
  labelOldFindings,
  labelVisualReferences,
  mergeGoalTask,
  noSummaryYet,
  researchTopicTask,
  synthesisDirectionsTask,
  synthesisGoalTask,
  thinkingOriginDocumentBlock
} from "./steps/fragments";
import {
  isManagedMapPath,
  moveNotePath,
  normalizeReasoningLevel,
  normalizeMapChatStyle,
  normalizeMapChatOpen,
  rebaseMapNotePaths,
  failureReason,
  type Note,
  type NotePatch,
  type TopicInfo,
  isPlaceholder
} from "../../repository";
import { canonicalDetail, visualReferencesMarkdown } from "../../ai/result-utils";
import {
  checkCounts,
  countIssueText,
  builtinTemplates,
  isBuiltinTemplateId,
  resolveTemplate,
  STANDARD_TEMPLATE_ID,
  type CountIssue,
  type DetailTemplate
} from "../../ai/detail-templates";
import {
  DEFAULT_OUTLINE_PRESET_ID,
  DEFAULT_TONE_ID,
  listPresets,
  resolvePreset,
  resolveToneText
} from "../../ai/prompt-presets";
import { matchPreset, NOTE_STYLE_PRESETS, styleLabel } from "./note-style";
import type { AiResult, ReasoningLevel, Suggestion, TaskContext } from "../../ai/types";
import { previewMetrics } from "../../ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample, SAMPLE_TOUR_VERSION } from "../../builtin-sample";
import {
  normalizeRelevanceContext,
  normalizeRelevanceGoal,
  normalizeRelevanceLevel,
  RELEVANCE_CONTEXT_MAX_LENGTH,
  RELEVANCE_GOAL_MAX_LENGTH,
  HYPOTHESIS_STRENGTHS,
  TOPIC_KINDS,
  RELEVANCE_LEVELS,
  type HypothesisStrength,
  type NoteRelevance,
  type RelevanceLevel,
  type RelevanceTier,
  type TopicKind
} from "../../note-values";
import { RELEVANCE_LABEL, renderRelevanceTagButton } from "./relevance-tag";
import { renderHypothesisTag, STRENGTH_LABEL } from "./hypothesis-label";
import { relevanceDisplayNodes } from "./relevance-order";
import { fitViewport, focusViewport, initialViewport, insetFromRects } from "./viewport-inset";
import { RelevanceSummaryModal } from "./relevance-summary-modal";
import {
  MapChatPanel,
  type MapChatChip,
  type MapChatHost,
  type MapChatImageItem,
  type MapChatImages,
  type MapChatInsertResult,
  type MapChatLine,
  type MapChatOrigin,
  type MapChatPlanCard,
  type MapChatSavedTurn,
  settledLine
} from "./map-chat";
import { imageMarkdown, type ImageCandidate } from "../../core/image-candidates";
import {
  chatNoteName,
  transcriptMarkdown,
  type TranscriptRef,
  type TranscriptTurn
} from "../../core/map-chat-transcript";
import { loadableImages } from "../../ui/image-candidates";
import {
  buildMapChatContext,
  contentHash,
  isMdStale,
  type MapChatContext,
  type MapChatOutlineNode,
  type MapChatTopicHash,
  type MapChatTopicRef
} from "../../core/map-chat-context";
import { applyMdEdit, guardMapChatWrite, normalizeVaultPath, type MapChatGuardCode } from "../../core/map-chat-guard";
import type { MapChatRequest, MapChatResult } from "../../core/map-chat-service";
import { FIRST_EVENT_WAIT_MS } from "../../core/ai-task-service";
import { MAP_CHAT_NEW_PREFIX, type MapChatAction } from "../../core/steps/map-chat/step";
import {
  MAP_CHAT_AUTO_LAYOUT_MIN_NEW,
  chatResearchMode,
  MAP_CHAT_FIND_IMAGES_LIMIT,
  chatResearchRequest,
  mapChoiceParts,
  matchMapTitle,
  planFor,
  researchTargetsOf,
  type MapChatPlan,
  type MapChatPlanReason
} from "../../core/map-chat-plan";
import {
  CHAT_PLAN_GROUP_ORDER,
  chatDockedWidth,
  chatOverlayWidth,
  chatPlanGroupOf,
  clampMapChatWidth,
  isChatNarrow
} from "../../core/map-chat-layout";
import { relevanceMode, relevanceModeAfterWrite, type RelevanceMode, type RelevancePin } from "./relevance-pins";
import { PendingSuggestions } from "../../pending-suggestions";
import { createAimMap } from "../aim/create-map";
import {
  addOutlineToMap,
  createOutlineMap,
  limitOutline,
  OUTLINE_NODE_LIMIT,
  OUTLINE_TITLE_LIMIT,
  type OutlineNode
} from "./outline-import";
import {
  buildClipboardPayload,
  clipboardOutline,
  parseClipboard,
  serializeClipboard,
  type ClipboardPayload
} from "./clipboard";
import { inClipboardScope, readClipboardData, writeClipboardData } from "./clipboard-io";
import { canPasteCut, planPaste, resolveCrossSource } from "./clipboard-paste";
import { PASTE_TEXT_MAX_CHARS, parseIndentedText, type IndentedTextRejection } from "./clipboard-text";
import { sessionFor, type ClipRecord } from "./clipboard-session";
import { cutSourceProblem, ledgerFor, sameApartFromStamps } from "./cross-map-history";
import {
  OutlineImportModal,
  type OutlineDraftInputs,
  type OutlineDraftPrefill,
  type OutlineGenerator,
  type OutlineImportRequest,
  type OutlineImportTarget,
  type OutlinePlacement
} from "./outline-import-modal";
import { exportMapWithNotice } from "./outline-exchange-io";
import { MultiResearchModal, type MultiResearchRequest } from "./multi-research-modal";
import { StructureReviewModal } from "./structure-review-modal";
import {
  buildStructureReviewNodes,
  isSuggestionStale,
  type StructureNode,
  type StructureReviewResult,
  type StructureSuggestion
} from "../../core/structure-review-service";
import type {
  RelevanceGradeChange,
  RelevanceGradeItem,
  RelevanceGradeOutcome,
  RelevanceReceived,
  RelevanceGradeResult,
  RelevanceGradeRun
} from "../../core/relevance-grade-service";
import { RELEVANCE_GRADE_SCHEMA, RELEVANCE_RECALIBRATE_SCHEMA } from "../../core/relevance-grade-service";
import { renderTopicTree } from "../../ui/topic-tree";
import { TopicTreeModal } from "../../ui/modals/topic-tree-modal";
import type { FieldLinks, ModelChoices } from "./research-fields";
import { aiModeOptions, hasKnowledgeGapMarker, noteAiMode, type MapAiMode } from "./ai-mode";
import type { ResearchObserver } from "../../ai/research-observer";
import type { ResearchProgress } from "./research-progress";
import { DetailTemplatesModal } from "../../ui/modals/detail-templates-modal";
import type { ExpansionBatchState } from "./expansion-batch";
import { AimStartModal } from "../../ui/modals/aim-start-modal";
import { AimAnswerModal } from "../../ui/modals/aim-answer-modal";
import { AimAssumptionModal } from "../../ui/modals/aim-assumption-modal";
import { AimSteerModal } from "../../ui/modals/aim-steer-modal";
import {
  AimManualFlow,
  readOpenItems,
  countAimAnsweredQuestions,
  MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION,
  type ManualResearchResult,
  type PlannerQuestionResult
} from "../aim/manual-flow";
import { AimRunStore } from "../aim/research-run-store";
import type { AimProgressEvent } from "../aim/manual-flow-support";
import { matchAimFailedReportTargets } from "../aim/retry-targets";
import { aimRepairHint, aimTimedOut } from "../aim/failure-hint";
import { canvasPointerIntent } from "./canvas-gestures";
import {
  hasMergeContent,
  mergedDetail,
  mergedStatus,
  mergeTitleFromResult,
  mergeEligibility,
  MergeTopicsModal,
  resolveMergeModel,
  type MergeEligibility
} from "./merge-topics";

import {
  TaskOptions,
  type RunOnceModel,
  imageReferencesFromMarkdown,
  PartialChildBatchError,
  AgentTaskHandle,
  TaskSourceSettings,
  NextStepModal,
  type OutputLanguageMemory,
  type AiModeMemory,
  type BackgroundHooks,
  type PendingOutline,
  outlineProposals,
  proposalOutline,
  type QuickOutline,
  type SynthesisObserver,
  armDiscard,
  renderProposalList,
  ChildProposalModal,
  MapConflictModal,
  NoteCollectionModal,
  TopicPickerModal
} from "./modals";

const BRANCH_DIRECTIONS: BranchDirection[] = ["right", "left", "down", "up"];
const BRANCH_LABEL = {
  right: "ui.layout_direction_right",
  left: "ui.layout_direction_left",
  down: "ui.layout_direction_down",
  up: "ui.layout_direction_up"
} as const;
export const VIEW_TYPE = "visual-agent-map-view";
/** What a cross-map cut adds to writeNewBranches: its own transaction, the source map's part of it, and the success step. */
interface CrossCut {
  /** Reads what must be put back byte for byte if the commit fails; runs before `begin`. */
  snapshot: () => Promise<void>;
  /** After a failed commit that rolled back cleanly: puts back the exact text of what the rollback only restored in value. */
  restore: () => Promise<void>;
  begin: () => Transaction;
  join: (tx: Transaction) => void;
  finish: (entry: TransactionEntry) => Promise<void>;
}
interface Action {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
}
/** Message of any thrown value, without relying on instanceof Error (errors may cross realms). */
const EDITABLE_SELECTOR = ["input", "textarea", "select", "[contenteditable]:not([contenteditable=false])"].join(",");
/** Elements that own their own click: a canvas-level pointer capture must never start from inside one. */
const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  '[contenteditable="true"]',
  '[role="button"]'
].join(",");
/** True when a key event came from a text control, where the field owns the key (undo, Backspace, typing). */
function isEditableTarget(target: unknown): boolean {
  return !!(target as Element | null)?.closest?.(EDITABLE_SELECTOR);
}
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
/** A note's stored "no conclusion yet" placeholder is written in the note's own language; in an AI prompt it is shown in the task's output language. */
function summaryForPrompt(summary: string, language: ContentLanguage): string {
  return isPlaceholder(summary) ? translateNote(noteLanguageOf(language), "note.no_conclusion_yet") : summary;
}
/**
 * The built-in Standard and Textbook templates follow the output language, as the fixed Detail headings always did; their
 * display name uses `language` itself, so a Simplified Chinese interface labels the template "标准", not "標準".
 */
function templateInLanguage(template: DetailTemplate, language: ContentLanguage): DetailTemplate {
  return isBuiltinTemplateId(template.id)
    ? builtinTemplates(noteLanguageOf(language), language).find(item => item.id === template.id)!
    : template;
}
/**
 * Unmet section counts to store on the topic; undefined (no count check ran) clears an earlier mark. The text is written
 * into the note's frontmatter, so it is in the note language, never a display-only interface language.
 */
export function formatIssuesPatch(
  issues: CountIssue[] | undefined,
  language: ContentLanguage
): Pick<NotePatch, "detailFormatIssues"> {
  return { detailFormatIssues: (issues ?? []).map(issue => countIssueText(issue, noteLanguageOf(language))) };
}
const originBaseline = (origin?: string): string =>
  createHash("sha256")
    .update(origin ?? "")
    .digest("hex");

type AimQuestionStatus = "running" | "completed" | "partial" | "failed" | "cancelled" | "not_started";
function aimQuestionStatus(
  map: MapDocument,
  questionNodeId: string,
  activeQuestionNodeId: string | null
): AimQuestionStatus {
  if (activeQuestionNodeId === questionNodeId) return "running";
  const branches = map.aim?.branches.filter(branch => branch.questionNodeId === questionNodeId) ?? [];
  const statuses = branches.map(branch => {
    if (branch.researchPlanError && !branch.researchPlan) return "failed" as const;
    const runs = (map.aim?.runs ?? []).filter(item => item.branchId === branch.id);
    if (
      runs.some(run => {
        const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      })
    )
      return "running" as const;
    const terminal = [...branch.results].reverse().find(result => result.kind !== "research");
    if (terminal) {
      const terminalRun = runs.find(item => item.id === terminal.runId),
        terminalAttempt = terminalRun?.attempts.find(item => item.id === terminal.attemptId);
      const latestRun = [...runs].reverse()[0],
        latestAttempt = latestRun?.attempts.find(item => item.id === latestRun.currentAttemptId);
      if (latestAttempt?.status === "failed") return "failed" as const;
      if (latestAttempt?.status === "cancelled") return "cancelled" as const;
      return terminalAttempt?.status === "partial" ? ("partial" as const) : ("completed" as const);
    }
    const latest = [...runs].reverse().find(run => run.attempts.some(item => item.id === run.currentAttemptId));
    const status = latest?.attempts.find(item => item.id === latest.currentAttemptId)?.status;
    if (status === "failed") return "failed" as const;
    if (status === "cancelled") return "cancelled" as const;
    return branch.researchPlan || branch.results.length || status === "completed"
      ? ("partial" as const)
      : ("not_started" as const);
  });
  if (statuses.includes("running")) return "running";
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("partial")) return "partial";
  if (statuses.includes("completed")) return "completed";
  if (statuses.includes("cancelled")) return "cancelled";
  return "not_started";
}
/** The AI merge that hid its dialog: owned by the view, one per map. It writes nothing until the draft is confirmed. */
interface MergeTask {
  mapPath: string;
  mapId: string;
  mapTitle: string;
  /** The fallback name (first source's title) until the AI names the topic; then the AI's name. */
  title: string;
  sources: { id: string; path: string }[];
  parentId: string | null;
  /** Parent mode: the parent topic that keeps its card (first of `sources`); null when a new topic replaces siblings. */
  targetId: string | null;
  model: string;
  reasoning: ModelChoice["reasoning"];
  /** The sources as sent to the model (JSON of the reference documents); compared again before the draft is saved. */
  sourceContent: string;
  controller: AbortController;
  /** running: the model works (Stop works); applying: the result is being written; a task that ends is removed. */
  state: "running" | "applying";
  progress: string;
  draft?: AiResult;
  /** The request in flight (tests await it). */
  run?: Promise<void>;
}
/** Progress keys for runs that have no card (multi-select synthesis, AI merge); Obsidian file names cannot contain ":". */
const TASK_PROGRESS_PREFIX = "vam-task:";
/** How long the "merged, can undo" Notice stays, so its Undo button can be used. */
const MERGE_DONE_NOTICE_MS = 15000;
/** Owner 2026-10-28: the AI structure review stays in the code but the Next Step dialog no longer offers it; flip to show it again. */
const STRUCTURE_REVIEW_ENTRY_SHOWN = false;
/**
 * Writes an AI synthesis result into the parent topic. `save` re-checks the map, sources and parent note and throws
 * (writing nothing) when anything changed; the caller decides whether the run may still write before calling it.
 */
type SynthesisWrite = (
  result: AiResult,
  save: (summary: string, detail: string) => Promise<void>,
  summary: string,
  detail: string
) => void | Promise<void>;
/** Unique ids for the hidden card labels; any view may render a card. */
let cardLabelSequence = 0;
const cardLabels = new WeakMap<HTMLElement, HTMLElement>();
/** The extra accessible-name part of a card that is waiting to be moved by a paste ("cut"). */
const cardCutLabels = new WeakMap<HTMLElement, HTMLElement>();
/** The model tag drawn in a card header, so a redraw replaces exactly it. */
/** The cover frame and image drawn on each card, so a redraw can remove them without searching the card. */
const cardCovers = new WeakMap<HTMLElement, { frame: HTMLElement; img: HTMLImageElement }>();
const cardModelTags = new WeakMap<HTMLElement, HTMLElement>();
/** The marker row drawn in each card header, so a refresh can replace it. */
const cardMarkerRows = new WeakMap<HTMLElement, HTMLElement>();
/** Identifies one relevance grading run, so a late result can tell it is no longer the current one. */
let relevanceRunToken = 0;
let relevancePanelSeq = 0;
/** Maps whose cards are displayed sorted by relevance. Memory only: never written to a note or Map.md. */
const relevanceSortedMaps = new Set<string>();
/** Path data for the curve from a parent card's right edge to a child card's left edge. */
/** `layoutDirectionFor` for many ids at once: builds the id lookup one time and remembers each answer. */
function branchDirectionResolver(nodes: MapNode[], mapDirection: string): (id: string) => string {
  if (!allowsBranchLayout(mapDirection)) return () => mapDirection;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const known = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const hit = known.get(id);
    if (hit !== undefined) return hit;
    const node = byId.get(id);
    let answer = mapDirection;
    if (node && !seen.has(id)) {
      seen.add(id);
      answer = branchDirectionOf(node) ?? (node.parentId ? resolve(node.parentId, seen) : mapDirection);
    }
    known.set(id, answer);
    return answer;
  };
  return id => resolve(id, new Set());
}
function edgePathData(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
/** Unique ids for the arrowhead `<marker>`s: two map tabs share one document, so an id must belong to one view. */
let relationMarkerSequence = 0;
let relationSwatchSequence = 0;
/** The structure dialog lists the types in the order of spec section 2 (not TOPIC_KINDS order, which the menus keep). */
const KIND_PICKER_ORDER: readonly TopicKind[] = ["topic", "atomic", "hypothesis", "evidence", "conclusion", "action"];
type CardBox = RelationBox;
/** Below this zoom the relation names are hidden; at it they show. */
const RELATION_LABEL_MIN_ZOOM = 0.6;
/** A note shown under an expanded label is cut to this many characters. */
const RELATION_LABEL_NOTE_MAX = 60;
/** A card's distance from its root (a root is 0); only the fishbone edge reads it. */
function depthOf(nodes: MapNode[], id: string): number {
  const byId = new Map(nodes.map(node => [node.id, node]));
  let depth = 0;
  for (let node = byId.get(id); node?.parentId && depth < nodes.length; node = byId.get(node.parentId)) depth++;
  return depth;
}
const BOUNDARY_PAD = 16;
const boxOf = (card: HTMLElement): CardBox => ({
  x: card.offsetLeft,
  y: card.offsetTop,
  width: card.offsetWidth,
  height: card.offsetHeight
});

/** One planned subtopic of the running AIM branch, as the map shows it before its research note exists. */
type AimTargetProgress = {
  title: string;
  state: "queued" | "searching" | "done" | "skipped";
  searches: number;
  startedAt?: number;
};

const TOPIC_KIND_ICON: Record<TopicKind, string> = {
  topic: "circle",
  action: "square-check",
  atomic: "atom",
  hypothesis: "lightbulb",
  evidence: "file-search",
  conclusion: "flag"
};
const RELATION_KINDS: readonly TopicRelationKind[] = [
  "supports",
  "contradicts",
  "verifies",
  "derives_from",
  "related",
  "prerequisite"
];
/** One sentence per kind, "A ... B" with A the source and B the target, worded for each language rather than by word order. */
const RELATION_SENTENCE_KEY: Record<Exclude<TopicRelationKind, "related">, Parameters<typeof t>[0]> = {
  supports: "ui.relation_sentence_supports_0_1",
  contradicts: "ui.relation_sentence_contradicts_0_1",
  verifies: "ui.relation_sentence_verifies_0_1",
  derives_from: "ui.relation_sentence_derives_from_0_1",
  prerequisite: "ui.relation_sentence_prerequisite_0_1"
};
const RELATION_NAME_KEY: Record<TopicRelationKind, Parameters<typeof t>[0]> = {
  supports: "ui.relation_name_supports",
  contradicts: "ui.relation_name_contradicts",
  verifies: "ui.relation_name_verifies",
  derives_from: "ui.relation_name_derives_from",
  related: "ui.relation_name_related",
  prerequisite: "ui.relation_name_prerequisite"
};
/** The key a relation line is known by (view state only): `from`, `to` and kind. */
const relationIdentity = (r: Pick<TopicRelation, "kind" | "from" | "to">): string =>
  `${r.from}\u0000${r.to}\u0000${r.kind}`;
const AIM_STAGE_KEYS: Record<string, Parameters<typeof t>[0]> = {
  "research-plan": "ui.aim_stage_research-plan",
  "report-review": "ui.aim_stage_report-review",
  "targeted-research": "ui.aim_stage_targeted-research",
  "delivery-outline": "ui.aim_stage_delivery-outline",
  "delivery-research": "ui.aim_stage_delivery-research",
  "delivery-writing": "ui.aim_stage_delivery-writing",
  "delivery-acceptance": "ui.aim_stage_delivery-acceptance",
  "add-diagrams": "ui.aim_stage_add-diagrams"
};

/** One "document ready" notice at a time: a new one replaces the last, and it closes itself after a minute. */
let documentReadyNotice: Notice | null = null;
function showDocumentReady(): void {
  documentReadyNotice?.hide();
  documentReadyNotice = new Notice(t("ui.aim_document_ready"), 60_000);
}

/**
 * The options a chat integration runs with: what the integration dialog hands over when its fields are left as they come up
 * (no sources picked, no web search or images, the full content of the subtopics, no template or tone chosen, no extra
 * requirements). An integration is always Quick (no web search; D-2026-10-229). `synthesisTitle` is the new topic's name and
 * only a multi-select integration has one. Pure, so a test can hold it against the real dialog.
 */
export function chatSynthesisOptions(input: { outputLanguage: ContentLanguage; synthesisTitle?: string }): TaskOptions {
  return {
    synthesisContent: "full",
    referenceGroups: [],
    outputLanguage: input.outputLanguage,
    requirements: "",
    researchMode: "local",
    researchDepth: "normal",
    visualMode: "off",
    ...(input.synthesisTitle !== undefined ? { synthesisTitle: input.synthesisTitle } : {})
  };
}
/** Web activity of the topics a research batch finished: searches made, topics that reported it, and those that made none. */
interface ResearchWebTally {
  searches: number;
  counted: number;
  withoutSearch: number;
}
/** The lines that say how many web searches a research batch made; a topic with none is a warning of its own. */
function researchWebLines(web: ResearchWebTally): MapChatLine[] {
  if (!web.counted) return [];
  const lines: MapChatLine[] = [{ status: "done", text: t("ui.multi_research_searches_0", web.searches) }];
  if (web.withoutSearch) lines.push({ status: "skipped", text: t("ui.multi_research_no_search_0", web.withoutSearch) });
  return lines;
}
/** What one chat action came to: written, skipped with a reason (shown in the chat), or failed. */
type ChatOutcome =
  { status: "done"; images?: MapChatImages } | { status: "skipped" | "failed"; reason: string; created?: boolean };
/** What the writes of one reply have made so far: the real id behind each `ref`, and the cards created, in order. */
interface ChatRun {
  refs: Map<string, string>;
  created: string[];
  /** A card was (or may have been) written without rebuilding the derived data; one rebuild at the end of the reply does it. */
  ownershipDirty?: boolean;
  /** True for a held batch (five cards or more): its cards leave the derived data to the one rebuild at the end. */
  deferRebuild?: boolean;
}
/** The narrow edge the laid-over chat window leaves in place, and the gap the tool group keeps from the window. */
const CHAT_RAIL_WIDTH = 44;
const CHAT_TOOLS_GAP = 12;
/** The size of a chat expand: the Next Step dialog's defaults (levels below the topic, topics in total). */
const CHAT_EXPAND_LEVELS = 2;
const CHAT_EXPAND_MAX_TOPICS = 15;
const skipped = (key: TranslationKey): ChatOutcome => ({ status: "skipped", reason: t(key) });
const GUARD_REASON: Record<MapChatGuardCode, TranslationKey> = {
  outside_vault: "ui.map_chat_guard_outside_vault",
  config_dir: "ui.map_chat_guard_config_dir",
  not_markdown: "ui.map_chat_guard_not_markdown",
  map_unparseable: "ui.map_chat_guard_map_unparseable",
  map_file: "ui.map_chat_guard_map_file",
  duplicate_identity_key: "ui.map_chat_guard_duplicate_identity_key",
  topic_identity_changed: "ui.map_chat_guard_topic_identity_changed",
  reserved_frontmatter: "ui.map_chat_guard_reserved_frontmatter",
  hypothesis_frontmatter_changed: "ui.map_chat_guard_hypothesis_frontmatter_changed",
  exists: "ui.map_chat_guard_exists",
  no_baseline: "ui.map_chat_guard_no_baseline"
};
const guardSkipped = (code: MapChatGuardCode, editing = false): ChatOutcome =>
  skipped(editing && code === "reserved_frontmatter" ? "ui.map_chat_guard_identity_added" : GUARD_REASON[code]);
let mapChatTaskSequence = 0;

/** The same key for both directions: a pair of topics holds one relation (spec V1.7). */
function relationPairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

export class VisualAgentMapView extends ItemView {
  private map: MapDocument | null = null;
  /** Prerequisite links the last merge or merge-style removal dropped because they would have closed a cycle (read by the notice that reports it). */
  private lastDroppedCycles = 0;
  /** Relations the last merge dropped because the merged topic already had one with the same other topic (one relation per pair, decision 37). */
  private lastDroppedSamePair = 0;
  /** How many same-pair relations the latest merge dropped (0 when none). */
  droppedSamePairOfLastMerge(): number {
    return this.lastDroppedSamePair;
  }
  /** How many prerequisite links the latest merge dropped to avoid a cycle (0 when none); P4 reports it. */
  droppedCyclesOfLastMerge(): number {
    return this.lastDroppedCycles;
  }
  private path = "";
  private notes = new Map<string, Note>();
  /** Learning goal from the map file's frontmatter; shown only on mind maps (never AIM) and absent when not graded. */
  private relevanceGoal: string | undefined;
  private relevanceLevel: RelevanceLevel | undefined;
  private relevanceContext: string | undefined;
  private selected: string | null = null;
  private multiSelected = new Set<string>();
  /** Cards named by the open structure review; marked with a class, cleared when the review closes. */
  private structureHighlight = new Set<string>();
  /** How many times the map was repainted; a run compares it to repaint once, not twice. */
  private paintCount = 0;
  /** True once this view has started a relevance grading run (so closing it has a run to abort). */
  private startedRelevance = false;
  private readonly relevancePanelId = `vam-relevance-panel-${++relevancePanelSeq}`;
  private relevancePanelOpen = false;
  private relevanceDraft: { goal: string; level: string; context: string } | null = null;
  private relevanceToolsEl: HTMLElement | null = null;
  private relevanceButtonEl: HTMLButtonElement | null = null;
  private relevancePanelEl: HTMLElement | null = null;
  private relevancePanelGen = 0;
  private relevancePanelCleanup: (() => void) | null = null;
  private history = new History<Action>();
  /** The AI chat window. It lives on the view, so a repaint keeps its messages, draft and chips. */
  private chat: MapChatPanel | null = null;
  /** The map the conversation belongs to; opening another map starts a new conversation. */
  private chatMapId = "";
  private chatController: AbortController | null = null;
  /** Takes back the send that is still preparing (no request yet): what Stop does before there is a request to abort. */
  private chatPrepAbandon: (() => void) | null = null;
  private chatTaskKey: string | null = null;
  /** Counts plans: a plan card only works while its number is the current one (a new message, another map or closing ends it). */
  private chatPlanToken = 0;
  /** True while the conversation itself switches maps (create_map, open_map): the conversation goes along instead of restarting. */
  private chatCarryOver = false;
  /** True while a confirmed plan is being applied; no new message is sent meanwhile. */
  private chatApplying = false;
  /** Picture searches the chat started and that have not ended; the view owns them, so closing it or leaving the map stops them. */
  private chatImageSearches = new Map<number, AbortController>();
  private chatImageSequence = 0;
  /** While a reply's actions are applied, repaints and the views' re-reads wait and happen once at the end (see holdChatBatch). */
  private renderHold = 0;
  private renderPending = false;
  private syncHold = 0;
  private syncPending = false;
  private heldViews: VisualAgentMapView[] = [];
  /** The hint on an empty canvas, which follows the chat while it builds a map. */
  private emptyMapEl: HTMLElement | null = null;
  private chatWorkspaceEl: HTMLElement | null = null;
  private chatOverlayEl: HTMLElement | null = null;
  /** The map whose opening screen has already taken the keyboard once. */
  private chatHeroFocusedFor: string | null = null;
  /** The note the user last had open beside the map; dropped text is assumed to come from it. */
  private lastMarkdownPath: string | null = null;
  private deletedMap: {
    path: string;
    content: string;
    map: MapDocument;
    deleted: boolean;
    deleteAction?: Action;
  } | null = null;
  private integrationTask: {
    title: string;
    goal: string;
    rules: string;
    sources: MapNode[];
    options: TaskOptions;
    mapPath: string;
    mapId: string;
    sourceContent: string;
    controller: AbortController;
    /** `applying`: the AI result passed its fences and is being written (no Stop; nothing to review). */
    state: "running" | "directions" | "applying" | "failed" | "cancelled";
    /** The step this run is on: the AI's suggested directions, or the draft itself. */
    step: "directions" | "draft";
    directions: Suggestion[];
    progress: string;
    /** The model (and reasoning) this run uses, resolved when it started; a retry asks its usage notice for the same one. */
    model: string;
    reasoning: ModelChoice["reasoning"];
  } | null = null;
  /** A multi-select synthesis step is starting (before its task exists), so a second request is refused. */
  private selectionStarting = false;
  /** A merge dialog is open or its write is queued; a second Merge press (or the Enter that confirmed) is ignored. */
  private mergeOpen = false;
  /** AI merges that hid their dialog, keyed by map path (one per map). */
  private mergeTasks = new Map<string, MergeTask>();

  /**
   * AI actions whose dialog hid itself and whose provider request is not accepted yet, keyed by node path (or
   * `selection:<map path>`). The value is the dialog's controller, so a card or bar Stop pressed before acceptance
   * reaches the run and no request is sent; the entry goes away once the run is accepted or ends.
   */
  private startingTasks = new Map<string, AbortController>();
  /** Quick outlines generated while their dialog was closed, keyed by node path; kept in memory until created. */
  private quickOutlines = new Map<
    string,
    { mapPath: string; nodes: OutlineNode[]; dropped: number; options: TaskOptions }
  >();
  /** The AI structure review that hid its window. The view owns it: Stop, the result and the highlights. */
  private structureReviewTask: {
    mapPath: string;
    scopeId: string | null;
    controller: AbortController;
    state: "running" | "done" | "failed";
    result?: StructureReviewResult;
    message?: string;
    /** Reopens the window with the result (staleness and apply still check the map as it is then). */
    reopen: (result: StructureReviewResult) => void;
  } | null = null;
  /** The AI outline generation that hid the import window, with the window's inputs so it can be reopened. */
  private outlineDraftTask: {
    mapPath: string;
    controller: AbortController;
    state: "running" | "done" | "failed" | "stopped";
    inputs: OutlineDraftInputs;
    markdown?: string;
    message?: string;
  } | null = null;
  private synthesisTasks = new Map<
    string,
    {
      mapPath: string;
      mapId: string;
      state: "running" | "directions" | "failed" | "cancelled";
      step: "directions" | "draft";
      controller: AbortController;
      progress: string;
      options: TaskOptions;
      directions: Suggestion[];
      direction: string;
    }
  >();
  private viewportEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private edgesEl: SVGSVGElement | null = null;
  /** The canvas image that had keyboard focus when a change repainted the canvas; focus goes back to it. */
  private focusItemId: string | null = null;
  /** Last pointer position over the canvas in client pixels; a pasted picture goes there (D6). */
  private lastCanvasPointer: { x: number; y: number } | null = null;
  private zoomLabel: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private viewportTimer: number | null = null;
  /** True while the Map.md conflict window of this view is open. */
  private conflictOpen = false;
  private hoverTimer: number | null = null;
  private hoverCard: HTMLElement | null = null;
  /** The unsaved-answer block of the open hover card, repainted as the preview grows. */
  private hoverResearch: { path: string; block: HTMLElement; summary: HTMLElement; detail: HTMLElement } | null = null;
  private unsubscribeResearch: (() => void) | null = null;
  /** What each card last showed of its research progress; a different signature means the card must be redrawn. */
  private researchSigs = new Map<string, string>();
  private researchElapsed = new Map<HTMLElement, number>();
  private researchTick: number | null = null;
  /** The status bar's "N of M received" text of the running grade; painted in place, never by a repaint. */
  private relevanceReceivedEl: HTMLElement | null = null;
  private researchRenderTimer: number | null = null;
  /** Persistent, visually hidden live region for research stage changes; outside contentEl so a render never rebuilds it. */
  private announcer: HTMLElement | null = null;
  private announcedStages = new Map<string, string>();
  /** The unsaved-summary line of each synthesis/merge status bar (a plain element outside every live region). */
  private taskPreviewEls = new Map<string, HTMLElement>();
  private integrationMode = false;
  private dragging = false;
  // A repaint asked for mid-drag waits here; the drag's settle runs it once.
  private renderAfterDrag = false;
  /** Ends the drag in progress (listeners, pending frame, flag); set only while a card is being dragged. */
  private dragCleanup: (() => void) | null = null;
  /** The map a card drag started on; a drag that outlives it must not write to, or add a reference from, another map. */
  private dragOrigin: { id: string; path: string } | null = null;
  private dragFrame: number | null = null;
  /** A viewport write is already waiting in the queue; it reads the viewport when it runs, so later saves join it. */
  private viewportQueued = false;
  private edgeEls = new Map<string, SVGPathElement>();
  /** The spine of each fishbone head on screen, keyed by the head's node id; a drag recomputes it. */
  private spineEls = new Map<string, SVGPathElement>();
  /** Evidence and prerequisite links on screen, keyed `from\0to\0kind`; a drag moves them with their cards. */
  private relationEls = new Map<string, SVGPathElement>();
  /** The wide transparent path over each relation line (the only part that takes the pointer) and the name shown at its midpoint. */
  private relationHitEls = new Map<string, SVGPathElement>();
  private relationLabelEls = new Map<string, SVGTextElement>();
  /** The canvas-coloured inner line of a "derives from" double line, per relation key; it moves with the outer line. */
  private relationGapEls = new Map<string, SVGPathElement>();
  private relationData = new Map<string, TopicRelation>();
  /** Labels whose text was written since the last redraw, and which of them show the expanded text. */
  private relationPainted = new Set<string>();
  private relationExpanded = new Set<string>();
  /** Where each label sits, so expanding or collapsing its text keeps it in place. */
  private relationLabelAt = new Map<string, { x: number; y: number }>();
  /** The relation line the user picked (key `from\0to\0kind`); view state only, never written to the file. */
  private selectedRelation: string | null = null;
  /** The line under the pointer (shows its name) and the line of a panel row under the pointer (acts like a selection). */
  private hoverRelation: string | null = null;
  private previewRelation: string | null = null;
  /** Cards currently carrying `is-relation-end`, so a repaint only touches the cards that change. */
  private relationEndIds = new Set<string>();
  /** Ids of this view's two arrowheads (plain, and with a bar for "contradicts"); unique per view so two open maps never share (or lose) one. */
  private readonly relationMarkerId = `vam-relation-arrow-${++relationMarkerSequence}`;
  private readonly relationBarMarkerId = `${this.relationMarkerId}-bar`;
  /** Evidence links already reported as the wrong way round, so a redraw does not log them again. */
  private suppressClickUntil = 0;
  /** Node whose card should hold keyboard focus once the next render finishes. */
  private focusNodeId: string | null = null;
  /** After a render, the resize handle of this card takes focus back (keyboard resizing rebuilds the canvas). */
  private focusResizeNodeId: string | null = null;
  /** Space held down: a drag pans the map even while selecting topics. */
  private spaceHeld = false;
  /** The single card in the tab order (roving tabindex); arrows move between the rest. */
  private tabStopId: string | null = null;
  /** Card element per topic id, rebuilt on every render, so a selection change touches only the affected cards. */
  private cardEls = new Map<string, HTMLElement>();
  /** Rendered card height in canvas units (offsetHeight ignores zoom). A card not on screen yet gets the median of the rendered ones; undefined when nothing is rendered. */
  private cardHeightOf = (id: string): number | undefined =>
    this.cardEls.get(id)?.offsetHeight || medianHeight([...this.cardEls.values()].map(card => card.offsetHeight));
  private cardChecks = new Map<string, HTMLInputElement>();
  /** Map search (Mod+F): the query, the current match and where Esc returns focus. Null while the search box is closed. */
  private mapSearch: {
    query: string;
    currentId: string | null;
    returnNodeId: string | null;
    returnEl: HTMLElement | null;
    announceTimer: number | null;
  } | null = null;
  private mapSearchBar: MapSearchBar | null = null;
  /** Presentation mode: null while not presenting. Lives in memory only; Map.md is never written by it. */
  private presentation: PresentationState | null = null;
  private presentationBarEl: HTMLElement | null = null;
  /** Lazy-loads card cover images; owned by this view, disconnected on every redraw and on close. */
  private coverObserver: IntersectionObserver | null = null;
  private selectionBarEl: HTMLElement | null = null;
  private hintEl: HTMLElement | null = null;
  /** While a card renders, its buttons stay out of the tab order until that card is focused. */
  private renderingCard = false;
  /** Set while render hands focus back to a card, so that refocus does not restart its preview. */
  private restoringFocus = false;
  private closed = false;
  private aimViewEpoch = 0;
  private mapOpenEpoch = 0;
  private headerTitle = "";
  private builtIn = false;
  private showSampleTour = false;
  private sampleTourStep = 0;
  private readonly aimRuns: AimRunStore;
  private readonly aimManual: AimManualFlow;
  private readonly aimRecovery: AimManualFlow;
  private aimBusy = false;
  private aimController: AbortController | null = null;
  private aimActiveQuestionNodeId: string | null = null;
  private aimActivityKind: "planning" | "research" | "clarifying" | null = null;
  /** Live progress of the running AIM branch; in memory only and dropped when the run ends. */
  private aimProgress: {
    branchId: string;
    stage: string;
    startedAt: number;
    targets: Map<string, AimTargetProgress>;
  } | null = null;
  /** Text spans the one-second tick rewrites in place, so progress never re-renders the whole map. */
  private aimProgressEls = new Map<string, HTMLElement>();
  /** Model of each AIM branch's root topic, resolved once when its first progress event arrives; dropped when the run ends. */
  private aimBranchModels = new Map<string, string>();
  private aimBranchModelPending = new Set<string>();
  private aimProgressTimer: number | null = null;
  private aimProgressRenderTimer: number | null = null;
  private aimFailedReports = new Map<string, { runId: string; diagnosticNotePath: string }>();
  private aimAnswerRequestIds = new Map<string, string>();
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: VisualAgentMapPlugin
  ) {
    super(leaf);
    // Once, here: Obsidian pushes view.scope when the leaf becomes active, which can be before onOpen() finishes.
    this.installUndoScope();
    this.aimRuns = new AimRunStore(plugin.repo);
    this.aimManual = new AimManualFlow(
      plugin.repo,
      this.aimRuns,
      (context, model, reasoning, signal, onWebSearchEvent) =>
        plugin.askModel(context, model, reasoning, signal, undefined, undefined, onWebSearchEvent),
      undefined,
      async <T>(operation: () => Promise<T>): Promise<T> => {
        let result!: T;
        await plugin.mutate(async () => {
          result = await operation();
        });
        return result;
      }
    );
    this.aimManual.onProgress = event => this.onAimProgress(event);
    this.aimManual.addDiagrams = request => plugin.addAimDiagrams(request);
    // openMapInMutation already owns the repository queue. Startup recovery must persist
    // directly within that scope instead of attempting to enqueue the same operation again.
    this.aimRecovery = new AimManualFlow(
      plugin.repo,
      this.aimRuns,
      (context, model, reasoning, signal, onWebSearchEvent) =>
        plugin.askModel(context, model, reasoning, signal, undefined, undefined, onWebSearchEvent)
    );
    this.aimRecovery.addDiagrams = request => plugin.addAimDiagrams(request);
  }
  getViewType(): string {
    return VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.map?.title ?? "Visual Agent Map";
  }
  getIcon(): string {
    return "brain-circuit";
  }
  getState(): Record<string, unknown> {
    return this.builtIn ? { sample: BUILTIN_SAMPLE_ID } : { file: this.path };
  }
  async setState(state: Record<string, unknown>, result: { history: boolean }): Promise<void> {
    if (state.sample === BUILTIN_SAMPLE_ID && !this.builtIn) await this.openBuiltInSample();
    else if (typeof state.file === "string" && state.file !== this.path) await this.openMap(state.file);
    await super.setState(state, result);
  }
  /** Keeps the chat's current-note chip and the source-note guess in step with which notes are open and shown. */
  private registerWorkspaceEvents(): void {
    const workspace = this.app.workspace;
    if (typeof workspace?.on !== "function" || typeof this.registerEvent !== "function") return;
    this.registerEvent(
      workspace.on("active-leaf-change", leaf => {
        if (leaf?.view instanceof MarkdownView && leaf.view.file) this.lastMarkdownPath = leaf.view.file.path;
        this.chat?.refreshNote();
      })
    );
    // A tab can be shown or hidden, or moved to another window, without the active leaf changing.
    this.registerEvent(workspace.on("layout-change", () => this.chat?.refreshNote()));
    // Collapsing or widening a side panel resizes the workspace, and it can hide the note that sat beside the map.
    this.registerEvent(workspace.on("resize", () => this.chat?.refreshNote()));
    // A note whose image or `topic-cover` just changed redraws only its own cover.
    const cache = this.app.metadataCache;
    if (typeof cache?.on === "function")
      this.registerEvent(
        cache.on("changed", file => {
          if (this.closed || this.builtIn || !this.map) return;
          const node = this.map.nodes.find(item => item.path === file.path);
          const card = node ? this.cardEls.get(node.id) : undefined;
          if (card && node) this.paintCover(card, node.path);
        })
      );
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.announcer?.remove();
    // Outside contentEl, which every render empties (test doubles without a container simply have no announcer).
    this.announcer = (this.containerEl as HTMLElement | undefined)?.createDiv({ cls: "vam-sr-only" }) ?? null;
    this.announcer?.setAttr("role", "status");
    this.announcer?.setAttr("aria-live", "polite");
    this.announcer?.setAttr("aria-atomic", "true");
    this.announcedStages.clear();
    this.unsubscribeResearch?.();
    this.unsubscribeResearch = this.plugin.researchProgress?.subscribe(path => this.onResearchProgress(path)) ?? null;
    const epoch = ++this.aimViewEpoch;
    this.mapOpenEpoch++;
    this.contentEl.addClass("vam-view");
    this.contentEl.tabIndex = 0;
    this.registerWorkspaceEvents();
    // Space-drag pans while selecting topics; typing a space in a field never arms it.
    this.registerDomEvent(this.contentEl.win ?? window, "keydown", event => {
      if (
        event.code === "Space" &&
        !(
          event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")
        )
      )
        this.spaceHeld = true;
    });
    this.registerDomEvent(this.contentEl.win ?? window, "keyup", event => {
      if (event.code === "Space") this.spaceHeld = false;
    });
    this.registerDomEvent(this.contentEl.win ?? window, "blur", () => {
      this.spaceHeld = false;
    });
    // Copy and paste of branches: on the document, popout windows included (decision #29, evidence/clipboard-mime.md).
    this.bindClipboard();
    // The listener belongs to the element (it goes away with it); a move to another window binds the new document.
    this.contentEl.onWindowMigrated?.(() => this.bindClipboard());
    // Presentation keys are taken in the capture phase, before any card or tree key handler can see them.
    this.registerDomEvent(this.contentEl, "keydown", event => this.presentationKey(event), { capture: true });
    this.registerDomEvent(this.contentEl, "keydown", event => {
      // Escape inside the chat window folds the window (the panel handles it); it never clears the map's selection.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true], .vam-map-chat")
      )
        return;
      if (event.key === "Escape") {
        const previous = this.selected,
          touched = [...this.multiSelected];
        const wasSelecting = this.integrationMode;
        this.selected = null;
        this.multiSelected.clear();
        this.selectedRelation = null;
        this.integrationMode = false;
        if (wasSelecting) this.render();
        else this.commitSelection(previous, null, touched);
      }
    });
    await this.plugin.ready;
    if (this.closed || this.aimViewEpoch !== epoch) return;
    if (!this.path && !this.builtIn) {
      if (this.plugin.consumeFirstInstallSample()) await this.openBuiltInSample();
      else if (!this.plugin.repo.workspaceExists()) this.render();
      else {
        const files = await this.plugin.repo.mapFiles();
        if (this.closed || this.aimViewEpoch !== epoch) return;
        if (files.length) {
          let defaultPath = files[0].path;
          for (const file of files) {
            let candidate: MapDocument;
            try {
              candidate = await this.plugin.repo.readMap(file.path);
            } catch {
              continue;
            }
            if (this.closed || this.aimViewEpoch !== epoch) return;
            if (!candidate.aim) {
              defaultPath = file.path;
              break;
            }
          }
          await this.openMap(defaultPath);
        } else this.render();
      }
    }
  }
  /**
   * Mod+Z / Mod+Shift+Z while this view is the active pane, wherever focus is inside it. A text field keeps its own
   * undo (the handler passes the key through), and IME composition is never touched.
   */
  private installUndoScope(): void {
    const scope = new Scope(this.app.scope);
    const seen = new WeakSet<object>();
    const run =
      (redo: boolean) =>
      (event: KeyboardEvent): boolean => {
        if (this.closed || event.isComposing || isEditableTarget(event.target)) return true;
        // A presentation is read-only: undo and redo are swallowed, not passed on to Obsidian.
        if (this.presentation) return false;
        // Some hosts match the shifted letter as "Z" as well as "z"; one key press undoes one step.
        if (seen.has(event)) return false;
        seen.add(event);
        this.enqueue(() => this.travel(redo));
        return false;
      };
    scope.register(["Mod"], "z", run(false));
    scope.register(["Mod", "Shift"], "z", run(true));
    scope.register(["Mod", "Shift"], "Z", run(true));
    // F2 renames the focused map card. Obsidian binds F2 to "Rename file" at the app scope, so the view scope (which is
    // matched first) claims it only while a card has focus and otherwise lets the default command run.
    scope.register([], "F2", (event: KeyboardEvent): boolean => {
      if (this.closed || event.isComposing || event.defaultPrevented) return true;
      if (this.presentation) return false;
      if (this.builtIn || this.integrationMode || this.map?.aim) return true;
      const active = this.contentEl.ownerDocument?.activeElement;
      const entry = active ? [...this.cardEls.entries()].find(([, card]) => card === active) : undefined;
      const node = entry && this.map?.nodes.find(item => item.id === entry[0]);
      const note = node && this.notes.get(node.id);
      if (!node || !note) return true;
      this.renameNode(node, note.title);
      return false;
    });
    // Mod+Enter adds a subtopic and Shift+Enter a sibling of the focused card. Obsidian binds Mod+Enter to "open link in
    // new tab" and preventDefaults it at window capture before the card ever sees the key, so the view scope claims it
    // while a card has focus and otherwise lets the default command run.
    const cardKey =
      (sibling: boolean) =>
      (event: KeyboardEvent): boolean => {
        if (this.closed || event.isComposing || event.defaultPrevented) return true;
        if (this.presentation) return false;
        if (this.builtIn || this.integrationMode || this.map?.aim) return true;
        const active = this.contentEl.ownerDocument?.activeElement;
        const entry = active ? [...this.cardEls.entries()].find(([, card]) => card === active) : undefined;
        const node = entry && this.map?.nodes.find(item => item.id === entry[0]);
        if (!node) return true;
        const parent = sibling ? (this.map?.nodes.find(item => item.id === node.parentId) ?? null) : node;
        this.enqueue(() => this.addNode(parent));
        return false;
      };
    scope.register(["Mod"], "Enter", cardKey(false));
    scope.register(["Shift"], "Enter", cardKey(true));
    // Mod+F opens the map search only while the keyboard is on the map itself; in an editor, the chat or any field it stays Obsidian's.
    scope.register(["Mod"], "f", (event: KeyboardEvent): boolean => this.searchKey(event));
    this.scope = scope;
  }
  /** Mod+F: true leaves the key to Obsidian, false means the map search took it. */
  private searchKey(event: KeyboardEvent): boolean {
    if (this.closed || event.isComposing || event.defaultPrevented || !this.map) return true;
    // No search box while presenting; the key is swallowed so Obsidian's own search does not open over the show either.
    if (this.presentation) return false;
    const active = (this.contentEl.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    if (!active) return true;
    // The search field itself: Mod+F selects its text instead of opening Obsidian's search.
    if (this.mapSearchBar && active === this.mapSearchBar.input) {
      this.focusMapSearch();
      return false;
    }
    if (!this.contentEl.contains(active)) return true;
    if (isEditableTarget(active) || active.closest?.(".vam-map-chat")) return true;
    this.openMapSearch(active);
    return false;
  }
  private focusMapSearch(): void {
    const input = this.mapSearchBar?.input;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }
  private openMapSearch(origin: HTMLElement | null = null): void {
    if (this.closed || !this.map) return;
    if (this.mapSearch) {
      this.focusMapSearch();
      return;
    }
    const from = origin ?? ((this.contentEl.ownerDocument?.activeElement ?? null) as HTMLElement | null);
    const card = from ? [...this.cardEls.entries()].find(([, el]) => el === from || el.contains(from)) : undefined;
    this.mapSearch = {
      query: "",
      currentId: null,
      returnNodeId: card ? card[0] : null,
      returnEl: card ? null : from,
      announceTimer: null
    };
    this.mountMapSearch();
    this.applySearchMarks();
    this.focusMapSearch();
  }
  private mountMapSearch(): void {
    const search = this.mapSearch;
    const overlay = this.contentEl.querySelector?.<HTMLElement>(".vam-canvas-overlay");
    if (!search || !overlay) return;
    this.mapSearchBar = buildMapSearchBar(overlay, {
      query: search.query,
      label: t("ui.map_search_label"),
      closeLabel: t("ui.map_search_close"),
      countText: this.mapSearchCountText(),
      onInput: value => {
        search.query = value;
        search.currentId = null;
        this.applySearchMarks();
        this.announceSearchLater(search);
      },
      onStep: delta => this.enqueue(() => this.stepMapSearch(delta)),
      onClose: () => this.closeMapSearch(true)
    });
  }
  /** Call before a repaint: the returned function (call it after) rebuilds the box and gives the field its focus, query and caret back. */
  private holdMapSearch(): () => void {
    const bar = this.mapSearchBar;
    this.mapSearchBar = null;
    if (!this.mapSearch) return () => {};
    const focused = !!bar && this.contentEl?.ownerDocument?.activeElement === bar.input;
    const start = focused ? bar.input.selectionStart : null,
      end = focused ? bar.input.selectionEnd : null;
    return () => {
      if (!this.mapSearch) return;
      this.mountMapSearch();
      this.applySearchMarks();
      const input = this.mapSearchBar?.input;
      if (!focused || !input) return;
      input.focus({ preventScroll: true });
      if (start !== null && end !== null) input.setSelectionRange(start, end);
    };
  }
  private mapSearchResult(): MapSearchResult | null {
    if (!this.map || !this.mapSearch) return null;
    const vertical = ["down", "up"].includes(layoutOf(this.map).direction);
    return searchMap(
      this.map.nodes,
      supersededAimNodeIds(this.map),
      id => this.notes.get(id)?.title ?? "",
      this.mapSearch.query,
      vertical ? "x" : "y"
    );
  }
  private mapSearchCountText(): string {
    const search = this.mapSearch;
    if (!search || search.query === "") return "";
    const matches = this.mapSearchResult()?.matches ?? [];
    if (!matches.length) return t("ui.map_search_none");
    const at = search.currentId === null ? -1 : matches.indexOf(search.currentId);
    return at >= 0 ? `${at + 1}/${matches.length}` : t("ui.map_search_count_0", matches.length);
  }
  /** Marks the matching cards (the current one stronger) and refreshes the visible count. Never touches how a card is built. */
  private applySearchMarks(): void {
    const search = this.mapSearch;
    const matches = new Set(search ? (this.mapSearchResult()?.matches ?? []) : []);
    for (const [id, card] of this.cardEls) {
      card.toggleClass("is-search-match", matches.has(id));
      card.toggleClass("is-search-current", !!search && id === search.currentId && matches.has(id));
    }
    this.mapSearchBar?.setCount(this.mapSearchCountText());
  }
  /** Typing pauses for 300 ms before the count is spoken, so a screen reader does not read every keystroke. */
  private announceSearchLater(search: { query: string; announceTimer: number | null }): void {
    if (search.announceTimer !== null) window.clearTimeout(search.announceTimer);
    search.announceTimer = window.setTimeout(() => {
      search.announceTimer = null;
      if (this.closed || this.mapSearch !== search || search.query === "") return;
      const total = this.mapSearchResult()?.matches.length ?? 0;
      this.announcer?.setText(total ? t("ui.map_search_count_0", total) : t("ui.map_search_none"));
    }, 300);
  }
  /** Enter / Shift+Enter: jump to the next / previous match (cycling). A match inside folded branches opens them in one history step. */
  private async stepMapSearch(delta: 1 | -1): Promise<void> {
    const search = this.mapSearch;
    if (!search || !this.map || this.closed) return;
    if (search.announceTimer !== null) window.clearTimeout(search.announceTimer);
    search.announceTimer = null;
    const result = this.mapSearchResult();
    const step = result ? stepSearch(result, search.currentId, delta) : null;
    if (!step) {
      this.announcer?.setText(t("ui.map_search_none"));
      return;
    }
    search.currentId = step.id;
    const collapsed = collapsedAncestors(this.map.nodes, step.id);
    if (collapsed.length && this.builtIn) {
      // The sample is never saved, so its folds open in memory only.
      for (const item of this.map.nodes) if (collapsed.includes(item.id)) item.collapsed = false;
      this.render();
    } else if (collapsed.length) {
      await this.mapChange(map => {
        for (const item of map.nodes) if (collapsed.includes(item.id)) item.collapsed = false;
      });
    }
    if (this.closed || this.mapSearch !== search) return;
    const target = this.map?.nodes.find(item => item.id === step.id);
    if (!target) return;
    // Keyboard-style move: the camera follows in memory and Map.md's viewport is not written.
    this.focusNode(target, false);
    this.applySearchMarks();
    this.announcer?.setText(
      t("ui.map_search_position_0_1_2", step.index + 1, step.total, this.notes.get(step.id)?.title ?? "")
    );
  }
  /** Closes the box and clears the marks. Esc passes `restoreFocus`: focus returns to where the search began, else to the map. */
  private closeMapSearch(restoreFocus: boolean): void {
    const search = this.mapSearch;
    if (!search) return;
    if (search.announceTimer !== null) window.clearTimeout(search.announceTimer);
    this.mapSearch = null;
    this.mapSearchBar?.root.remove();
    this.mapSearchBar = null;
    for (const card of this.cardEls.values()) {
      card.toggleClass("is-search-match", false);
      card.toggleClass("is-search-current", false);
    }
    if (!restoreFocus || this.closed) return;
    const card = search.returnNodeId ? this.cardEls.get(search.returnNodeId) : undefined;
    const back =
      card ?? (search.returnEl?.isConnected && this.contentEl.contains(search.returnEl) ? search.returnEl : null);
    (back ?? this.contentEl).focus({ preventScroll: true });
  }
  /** The topics a presentation visits: the reading order of what is drawn (folded branches are one stop, not their descendants). */
  private presentationOrder(): string[] {
    if (!this.map) return [];
    const shown = new Set(this.canvasNodes().map(node => node.id));
    const vertical = ["down", "up"].includes(layoutOf(this.map).direction);
    return readingOrder(
      this.map.nodes.filter(node => shown.has(node.id)),
      { siblingAxis: vertical ? "x" : "y" }
    );
  }
  /** The start button is on only when there is something to show and the map is not in select mode. */
  private canPresent(): boolean {
    return !!this.map && !this.closed && !this.integrationMode && this.canvasNodes().length > 0;
  }
  private startPresentation(): void {
    if (this.presentation || !this.map || !this.canPresent()) return;
    const order = this.presentationOrder();
    const first = startingId(order, this.selected);
    if (first === null) return;
    const active = (this.contentEl.ownerDocument?.activeElement ?? null) as HTMLElement | null;
    const card = active
      ? [...this.cardEls.entries()].find(([, el]) => el === active || el.contains(active))
      : undefined;
    this.closeMapSearch(false);
    this.clearHoverTimer();
    this.hoverCard?.remove();
    this.hoverCard = null;
    this.presentation = {
      order,
      currentId: first,
      viewport: { ...this.map.viewport },
      selected: this.selected,
      multiSelected: [...this.multiSelected],
      returnNodeId: card ? card[0] : null,
      returnEl: card ? null : active
    };
    this.applyPresentationMarks(true);
  }
  /** One key of a presentation. Everything it does is in memory: the camera follows, nothing is saved. */
  private stepPresentation(action: PresentationAction): void {
    const session = this.presentation;
    if (!session) return;
    if (action === "exit") {
      this.exitPresentation(true);
      return;
    }
    if (action === "block") return;
    const move = moveInOrder(session.order, session.currentId, action);
    if (!move) return;
    if (move.kind === "edge") {
      this.announcer?.setText(t(move.edge === "first" ? "ui.presentation_first" : "ui.presentation_last"));
      return;
    }
    session.currentId = move.id;
    this.applyPresentationMarks(true);
  }
  /** Capture-phase keydown: a presentation takes its keys and the read-only ones, and nothing reaches the cards. */
  private presentationKey(event: KeyboardEvent): void {
    if (!this.presentation || this.closed) return;
    const target = event.target as HTMLElement | null;
    const inBar = !!target?.closest?.(".vam-presentation-bar");
    if (!inBar && target && (isEditableTarget(target) || target.closest?.(".vam-map-chat"))) return;
    // On the bar's own button Enter and Space click it.
    if (inBar && (event.key === "Enter" || event.key === " ")) return;
    const action = classifyPresentationKey(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    this.stepPresentation(action);
  }
  /**
   * Called at the end of every paint and after each step: re-reads the order (a repaint may have removed the current
   * topic), marks the current card, draws the bar, centres the card and keeps DOM focus on it.
   * `announce` speaks the position; a plain repaint speaks only when the topic changed under it.
   */
  private applyPresentationMarks(announce = false): void {
    const session = this.presentation;
    if (!session || !this.map) return;
    const order = this.presentationOrder();
    const currentId = reconcileCurrent(session.order, order, session.currentId);
    if (currentId === null) {
      this.exitPresentation(this.cardEls.size > 0);
      return;
    }
    if (currentId !== session.currentId) announce = true;
    session.order = order;
    session.currentId = currentId;
    this.contentEl.dataset.presenting = "true";
    if (this.stageEl) this.stageEl.dataset.presenting = "true";
    for (const [id, card] of this.cardEls) card.toggleClass("is-presenting", id === currentId);
    this.presentationBarEl?.remove();
    this.presentationBarEl = null;
    const overlay = this.contentEl.querySelector?.<HTMLElement>(".vam-canvas-overlay");
    const index = order.indexOf(currentId);
    if (overlay) {
      const bar = overlay.createDiv({ cls: "vam-presentation-bar", attr: { role: "group" } });
      bar.createSpan({ cls: "vam-presentation-count", text: t("ui.presentation_count_0_1", index + 1, order.length) });
      const exit = bar.createEl("button", {
        cls: "vam-presentation-exit",
        text: t("ui.presentation_exit"),
        attr: { type: "button" }
      });
      exit.addEventListener("click", event => {
        event.stopPropagation();
        this.exitPresentation(true);
      });
      this.presentationBarEl = bar;
    }
    const target = this.map.nodes.find(node => node.id === currentId);
    if (target) this.focusNode(target, false);
    const card = this.cardEls.get(currentId);
    const active = this.contentEl.ownerDocument?.activeElement ?? null;
    const lost = !active || active === this.contentEl || !this.contentEl.contains(active);
    if (card && (announce || lost) && active !== card) card.focus({ preventScroll: true });
    if (announce)
      this.announcer?.setText(
        t("ui.presentation_position_0_1_2", index + 1, order.length, this.notes.get(currentId)?.title ?? "")
      );
  }
  /**
   * Leaves the presentation. `restore` puts back the viewport (in memory, never saved), the selection and the focus;
   * switching maps or closing the view passes false because nothing of the old map is worth restoring.
   */
  private exitPresentation(restore = true): void {
    const session = this.presentation;
    if (!session) return;
    this.presentation = null;
    delete this.contentEl.dataset.presenting;
    if (this.stageEl) delete this.stageEl.dataset.presenting;
    this.presentationBarEl?.remove();
    this.presentationBarEl = null;
    for (const card of this.cardEls.values()) card.toggleClass("is-presenting", false);
    if (!restore || this.closed || !this.map) return;
    const ids = new Set(this.map.nodes.map(node => node.id));
    const previous = this.selected,
      touched = [...this.multiSelected];
    this.selected = session.selected !== null && ids.has(session.selected) ? session.selected : null;
    this.multiSelected = new Set(session.multiSelected.filter(id => ids.has(id)));
    this.commitSelection(previous, this.selected, [...touched, ...this.multiSelected]);
    if (!this.map) return;
    this.map.viewport = { ...session.viewport };
    this.transform();
    const card = session.returnNodeId ? this.cardEls.get(session.returnNodeId) : undefined;
    const back =
      card ?? (session.returnEl?.isConnected && this.contentEl.contains(session.returnEl) ? session.returnEl : null);
    (back ?? this.contentEl).focus({ preventScroll: true });
    this.announcer?.setText(t("ui.presentation_exited"));
  }
  /** The rename dialog shared by F2, the title double-click and the Rename tool. */
  private renameNode(node: MapNode, current: string): void {
    new NameModal(this.app, t("ui.new_topic_name"), current, name =>
      this.enqueue(() => this.noteChange(node, { title: name }))
    ).open();
  }
  async onClose(): Promise<void> {
    this.closed = true;
    this.closeMapSearch(false);
    this.exitPresentation(false);
    this.releaseCovers();
    this.unbindClipboard?.();
    this.unbindClipboard = null;
    this.renderAfterDrag = false;
    this.announcer?.remove();
    this.announcer = null;
    this.announcedStages.clear();
    this.unsubscribeResearch?.();
    this.unsubscribeResearch = null;
    if (this.researchTick !== null) window.clearInterval(this.researchTick);
    if (this.researchRenderTimer !== null) window.clearTimeout(this.researchRenderTimer);
    this.researchTick = this.researchRenderTimer = null;
    this.researchElapsed.clear();
    this.researchSigs.clear();
    this.taskPreviewEls.clear();
    this.hoverResearch = null;
    this.plugin.releaseOutline(this);
    this.abortMapChat();
    this.chat?.dispose();
    this.relevancePanelCleanup?.();
    this.relevancePanelCleanup = null;
    // An open panel pre-started the CLI for a grade that will never be sent.
    if (this.relevancePanelOpen) this.plugin.releaseWarmClaude?.();
    this.abortRelevanceGrade();
    for (const task of this.synthesisTasks.values()) if (task.state === "running") task.controller.abort();
    this.synthesisTasks.clear();
    for (const controller of this.startingTasks.values()) controller.abort();
    this.startingTasks.clear();
    for (const task of this.mergeTasks.values()) task.controller.abort();
    this.mergeTasks.clear();
    this.dropMapBackground();
    this.aimViewEpoch++;
    this.mapOpenEpoch++;
    const controller = this.aimController;
    this.aimController = null;
    this.aimBusy = false;
    this.aimActiveQuestionNodeId = null;
    this.aimActivityKind = null;
    controller?.abort();
    this.stopAimProgress();
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverCard?.remove();
    this.dragCleanup?.();
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persistViewport();
    }
  }
  /** The user switched to another map while AIM kept running: the document-ready notice still tells them it is done. */
  private noticeDocumentReadyElsewhere(status: string | undefined, epoch: number, mapPath: string): void {
    if (status === "completed" && !this.closed && this.aimViewEpoch === epoch && this.path !== mapPath)
      showDocumentReady();
  }
  private aimViewIsCurrent(epoch: number, mapPath: string): boolean {
    return !this.closed && this.aimViewEpoch === epoch && this.path === mapPath;
  }
  async refreshFromPlugin(): Promise<void> {
    if (this.builtIn) {
      const sample = builtInSample(noteLanguageOf(this.plugin.settings.language));
      if (this.map) sample.map.viewport = { ...this.map.viewport };
      this.map = sample.map;
      this.notes = sample.notes;
      this.renderPreservingFocus();
      return;
    }
    await this.hydrate();
    this.renderPreservingFocus();
  }
  private renderPreservingFocus(): void {
    const doc = this.contentEl?.ownerDocument;
    const current = doc?.activeElement ?? null;
    // The chat field is restored by render() itself (captureFocus / restoreChatFocus); an index lookup would land on another control.
    if (!doc || !current || !this.contentEl.contains(current) || this.chat?.isInput(current)) {
      this.render();
      return;
    }
    const focusedContainer = current === this.contentEl;
    const focusables = "button, input, select, textarea, [tabindex]:not([tabindex='-1'])";
    const before = Array.from(this.contentEl.querySelectorAll<HTMLElement>(focusables));
    const activeIndex = before.indexOf(current as HTMLElement);
    const active = current as HTMLInputElement;
    const selection =
      active.tagName === "INPUT" || active.tagName === "TEXTAREA"
        ? ([active.selectionStart, active.selectionEnd] as const)
        : null;
    this.render();
    const after = Array.from(this.contentEl.querySelectorAll<HTMLElement>(focusables));
    const target = after[activeIndex];
    if (focusedContainer) this.contentEl.focus();
    else target?.focus();
    if (
      selection &&
      (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") &&
      selection[0] !== null &&
      selection[1] !== null
    )
      (target as HTMLInputElement).setSelectionRange(selection[0], selection[1]);
  }
  syncOutline(): void {
    this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes, this.builtIn, this);
  }
  private enqueue(work: () => Promise<void>): void {
    void this.plugin.mutate(work).catch(() => {});
  }
  /** What the next-step dialogs need to preselect and record this map's output language (D-2026-10-88). */
  private outputLanguageMemory(): OutputLanguageMemory {
    const remembered = rememberedOutputLanguage(this.map);
    return {
      ...(remembered ? { outputLanguage: remembered } : {}),
      rememberOutputLanguage: language =>
        this.plugin.mutate(() =>
          this.mapChange(map => {
            map.outputLanguage = language;
          }, false)
        )
    };
  }
  /** What the research and expansion dialog needs to preselect and record this map's AI mode (D-2026-10-228). */
  private aiModeMemory(): AiModeMemory {
    return {
      ...(this.map?.aiMode ? { aiMode: this.map.aiMode } : {}),
      rememberAiMode: (mode: MapAiMode) =>
        this.plugin.mutate(async () => {
          // Unchanged: nothing to write (and no history entry).
          if (this.map?.aiMode === mode) return;
          await this.mapChange(map => {
            map.aiMode = mode;
          }, false);
        })
    };
  }
  /**
   * "Re-run with Standard": researches the topic again in Standard mode (web search, images), replacing the Quick result.
   * It goes through the usual usage notice and writes with the usual undo step, so the Quick result can be restored.
   */
  private rerunStandard(node: MapNode): void {
    void (async () => {
      const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
      if (this.plugin.running.has(node.path)) {
        new Notice(t("ui.ai_running_ai"));
        return;
      }
      await this.plugin.confirmAiUsage(note.model, async () => {
        const outputLanguage = outputLanguageForMap(this.map, this.plugin.settings.language, note.title);
        await this.runAgent(node, undefined, message => new Notice(message), {
          task: researchTopicTask(outputLanguage, note.title),
          referenceGroups: [],
          outputLanguage,
          rules: "",
          ...aiModeOptions("standard", "research")
        });
      });
    })().catch(error => new Notice(errorMessage(error)));
  }
  private async persist(): Promise<void> {
    if (!this.builtIn && this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map);
  }
  private async hydrate(isCurrent: () => boolean = () => true): Promise<void> {
    this.aimFailedReports.clear();
    if (this.builtIn) {
      if (isCurrent()) {
        this.notes = builtInSample(noteLanguageOf(this.plugin.settings.language)).notes;
        this.relevanceGoal = undefined;
        this.relevanceLevel = undefined;
        this.relevanceContext = undefined;
      }
      return;
    }
    let goal: string | undefined;
    let level: RelevanceLevel | undefined;
    let context: string | undefined;
    if (this.path && !this.map?.aim) {
      try {
        ({ goal, level, context } = await this.plugin.repo.readRelevanceSetup(this.path));
      } catch {
        /* An unreadable goal is simply not shown. */
      }
    }
    const loaded = new Map<string, Note>();
    for (const node of this.map?.nodes ?? []) {
      if (!isCurrent()) return;
      try {
        loaded.set(node.id, await this.plugin.repo.readNote(node.path, this.map ?? undefined));
      } catch {
        /* A missing note remains visible and removable on the map. */
      }
    }
    if (!isCurrent()) return;
    this.notes = loaded;
    this.relevanceGoal = goal;
    this.relevanceLevel = level;
    this.relevanceContext = context;
    await this.hydrateFailedReportTargets(isCurrent);
  }
  private async hydrateFailedReportTargets(isCurrent: () => boolean): Promise<void> {
    const map = this.map,
      mapPath = this.path;
    if (!mapPath || !map?.aim) return;
    const failed = map.aim.runs.some(
      run => run.attempts.find(item => item.id === run.currentAttemptId)?.status === "failed"
    );
    if (!failed) return;
    const notesFolder = this.plugin.repo.topicFolder(mapPath, "Notes"),
      candidates: Array<{ path: string; note: Note }> = [];
    for (const file of this.plugin.repo.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${notesFolder}/`)) continue;
      if (!isCurrent()) return;
      try {
        candidates.push({ path: file.path, note: await this.plugin.repo.readNote(file.path, this.map ?? undefined) });
      } catch {
        /* Unreadable notes cannot authorize a retry action. */
      }
    }
    if (!isCurrent()) return;
    this.aimFailedReports.clear();
    for (const [questionNodeId, target] of matchAimFailedReportTargets(map, candidates))
      this.aimFailedReports.set(questionNodeId, target);
  }
  /** Background AI work that belongs to the open map: stopped and forgotten when the view closes or another map opens. */
  private dropMapBackground(): void {
    this.quickOutlines.clear();
    const review = this.structureReviewTask;
    const draft = this.outlineDraftTask;
    this.structureReviewTask = null;
    this.outlineDraftTask = null;
    review?.controller.abort();
    draft?.controller.abort();
    this.highlightStructure([]);
  }
  async openMap(path: string): Promise<void> {
    await this.plugin.mutate(() => this.openMapInMutation(path));
  }
  private async openMapInMutation(path: string): Promise<void> {
    const viewEpoch = this.aimViewEpoch,
      openEpoch = ++this.mapOpenEpoch;
    const isCurrent = () => !this.closed && this.aimViewEpoch === viewEpoch && this.mapOpenEpoch === openEpoch;
    if (!isCurrent()) return;
    if (path !== this.path) {
      this.closeMapSearch(false);
      this.exitPresentation(false);
    }
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persistViewport();
      if (!isCurrent()) return;
    }
    if (path !== this.path) {
      this.stopAimProgress();
      if (this.relevancePanelOpen) this.plugin.releaseWarmClaude?.();
      this.abortRelevanceGrade();
    }
    let map = await this.plugin.repo.readMap(path);
    if (!isCurrent()) return;
    if (map.aim?.creationId && map.aim.rootDraft) {
      // The draft is compared with the current model and reasoning at this moment (plan D9); createAimMap decides
      // workspace or manual, so no field is added to the map data.
      const resumed = await createAimMap(this.plugin.repo, this.plugin.settings.cliModel, {
        requestId: map.aim.creationId,
        topic: map.title,
        context: map.aim.rootDraft.context,
        model: map.aim.rootDraft.model,
        reasoning: map.aim.rootDraft.reasoning
      });
      if (!isCurrent()) return;
      map = resumed.map;
    }
    if (map.aim?.questionDraft) {
      await this.aimRecovery.recoverQuestionDraft(path);
      if (!isCurrent()) return;
      map = await this.plugin.repo.readMap(path);
      if (!isCurrent()) return;
    }
    if (map.aim) {
      await this.aimRuns.recoverPending(path);
      if (!isCurrent()) return;
      await this.aimRuns.failInterrupted(path);
      if (!isCurrent()) return;
      await this.aimRecovery.recoverPostReportQuestions(path);
      if (!isCurrent()) return;
      map = await this.plugin.repo.readMap(path);
      if (!isCurrent()) return;
    }
    const clearedQuestionEdges = clearQuestionConvergenceEdges(map);
    const repairedResultEdges = repairAimResultConvergence(map);
    if (clearedQuestionEdges || repairedResultEdges) {
      await this.plugin.repo.saveMap(path, map);
      if (!isCurrent()) return;
    }
    if (this.builtIn || this.path !== path) this.plugin.closeStaleDetails();
    if (this.path !== path) this.dropMapBackground();
    this.builtIn = false;
    this.path = path;
    this.map = map;
    this.integrationMode = false;
    this.selected = null;
    this.multiSelected.clear();
    this.history.clear();
    this.restoreCrossProxies();
    await this.hydrate(isCurrent);
    if (!isCurrent()) return;
    await this.recoverInterruptedNotes(isCurrent);
    if (!isCurrent()) return;
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  /**
   * A note still at `status: running` that no task in this plugin instance owns was left by a reload or a closed Obsidian:
   * mark it as an error so the card stops saying "AI running". Runs inside the mutation queue, so it does not queue again.
   */
  private async recoverInterruptedNotes(isCurrent: () => boolean): Promise<void> {
    if (this.builtIn || !this.map) return;
    const message = t("ui.ai_task_interrupted_by_reload");
    for (const node of [...this.map.nodes]) {
      if (!isCurrent()) return;
      const note = this.notes.get(node.id);
      if (note?.status !== "running" || this.plugin.isNoteTaskBusy(node.path)) continue;
      try {
        await this.plugin.repo.markInterruptedRun(node.path, message, () => !this.plugin.isNoteTaskBusy(node.path));
        if (!isCurrent()) return;
        const fresh = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
        if (!isCurrent()) return;
        this.notes.set(node.id, fresh);
      } catch (error) {
        console.warn("Visual Agent Map interrupted run", error);
      }
    }
  }
  openAimStart(): void {
    if (this.closed) return;
    const epoch = this.aimViewEpoch;
    const isCurrent = () => !this.closed && this.aimViewEpoch === epoch;
    const availableModels = typeof this.plugin.availableModels === "function" ? this.plugin.availableModels() : [];
    const configuredModel = this.plugin.settings.cliModel?.trim() || FALLBACK_MODEL;
    const configuredReasoning = normalizeReasoningLevel(this.plugin.settings.cliReasoning);
    const defaultReasoning = configuredReasoning;
    const modelIds = [...new Set([configuredModel, ...availableModels].filter(Boolean))];
    const modelChoices = modelIds.map(id => ({
      id,
      label: typeof this.plugin.modelLabel === "function" ? this.plugin.modelLabel(id) : id
    }));
    new AimStartModal(
      this.app,
      input =>
        this.plugin.mutate(async () => {
          if (!isCurrent()) return;
          await this.plugin.repo.ensureWorkspace();
          if (!isCurrent()) return;
          const created = await createAimMap(this.plugin.repo, input.model, input);
          await this.plugin.rebuildDerivedData();
          if (!isCurrent()) return;
          await this.openMapInMutation(created.mapPath);
          if (!isCurrent() || this.path !== created.mapPath || this.map?.id !== created.map.id) return;
          this.selected = created.root.id;
          this.render();
          this.focusNode(created.root);
        }),
      modelChoices,
      configuredModel,
      defaultReasoning,
      async () => {
        const states = await Promise.all([
          this.plugin.refreshModelDiscovery("codex"),
          this.plugin.refreshModelDiscovery("claude")
        ]);
        const ready = states.filter(state => state.status === "ready");
        const models = [...new Set(ready.flatMap(state => state.models))];
        if (!ready.length || !models.length)
          throw new Error(
            states
              .map(state => state.error)
              .filter(Boolean)
              .join("; ") || t("ui.aim_no_models_found")
          );
        const choices = models.map(id => ({ id, label: this.plugin.modelLabel(id) }));
        const errors = states
          .filter(state => state.status === "error")
          .map(state => state.error)
          .filter(Boolean);
        return errors.length
          ? {
              models: choices,
              message: t("ui.aim_models_refreshed_partial_0", errors.join("; ")),
              preserveSelection: true
            }
          : choices;
      }
    ).open();
  }
  private modelChoices(): ModelChoices {
    return {
      list: () => this.plugin.availableModels().map(id => ({ id, label: this.plugin.modelLabel(id) })),
      watch: changed => {
        const unsubscribe = this.plugin.subscribeModelDiscovery(changed);
        void this.plugin.refreshModelDiscovery("codex");
        void this.plugin.refreshModelDiscovery("claude");
        return unsubscribe;
      }
    };
  }
  /** `{ toneText }` for a TaskContext, or nothing when the resolved tone is academic. */
  private toneField(
    note: Pick<Note, "toneId"> | undefined,
    options?: Pick<TaskOptions, "toneId" | "outputLanguage">
  ): { toneText: string } | Record<string, never> {
    const toneText = this.toneTextFor(note, options?.toneId, options?.outputLanguage ?? this.plugin.settings.language);
    return toneText ? { toneText } : {};
  }
  /** The name of the tone this topic resolves to now (topic override, else map default, else academic). */
  private toneLabelFor(note: Pick<Note, "toneId">): string {
    const settings = this.plugin.settings;
    const ids = [note.toneId, this.map?.toneId];
    for (const id of ids) {
      const found = listPresets(settings.promptPresets, "tone", settings.language).find(item => item.id === id);
      if (found) return found.name;
    }
    return listPresets(settings.promptPresets, "tone", settings.language).find(item => item.id === "academic")!.name;
  }
  /** Built-in plus custom writing tones, for the tone selects. */
  private toneChoices(): { id: string; name: string }[] {
    const settings = this.plugin.settings;
    return listPresets(settings.promptPresets, "tone", settings.language).map(({ id, name }) => ({ id, name }));
  }
  /**
   * Writing tone for an AI run on `note`: this run's choice, then the topic override, then the map default. Academic
   * (and nothing chosen) yields undefined so prompts stay unchanged.
   */
  private toneTextFor(
    note: Pick<Note, "toneId"> | undefined,
    chosenId?: string,
    language: ContentLanguage = this.plugin.settings.language
  ): string | undefined {
    return resolveToneText(this.plugin.settings.promptPresets, [chosenId, note?.toneId, this.map?.toneId], language);
  }
  /** The repair and edit-templates links beside a dialog's model and template fields. */
  private fieldLinks(): FieldLinks {
    return {
      repair: model => this.plugin.repairConnection(model),
      manageTemplates: (selected, refreshed) =>
        new DetailTemplatesModal(this.app, this.plugin, () => refreshed(this.templateChoices()), selected).open(),
      manageTones: (selected, refreshed) =>
        new PromptPresetsModal(this.app, this.plugin, "tone", () => refreshed(this.toneChoices()), selected).open()
    };
  }
  /** Built-in Standard and Textbook plus the workspace's custom templates, for the template selects. */
  private templateChoices(): { id: string; name: string }[] {
    const settings = this.plugin.settings;
    return [...builtinTemplates(noteLanguageOf(settings.language), settings.language), ...settings.detailTemplates].map(
      ({ id, name }) => ({ id, name })
    );
  }
  /** "Keep current (…)" name of the note style a topic (or this map) resolves to: a preset, else "Custom: …". */
  private currentStyleLabel(templateId: string, toneId: string): string {
    const names = (list: { id: string; name: string }[]) => (id: string) =>
      list.find(item => item.id === id)?.name ?? id;
    return styleLabel(
      templateId,
      toneId,
      { template: names(this.templateChoices()), tone: names(this.toneChoices()) },
      this.plugin.settings.language
    );
  }
  /** Name of the workspace default note style (default template, academic tone) for "Use the default (…)". */
  private defaultStyleLabel(): string {
    return this.currentStyleLabel(
      this.plugin.settings.defaultDetailTemplateId ?? STANDARD_TEMPLATE_ID,
      DEFAULT_TONE_ID
    );
  }
  /** The tone id a topic resolves to now (topic override, else map default, else academic), as toneLabelFor names it. */
  private effectiveToneId(note: Pick<Note, "toneId">): string {
    const settings = this.plugin.settings;
    const known = listPresets(settings.promptPresets, "tone", settings.language);
    return [note.toneId, this.map?.toneId].find(id => known.some(item => item.id === id)) ?? DEFAULT_TONE_ID;
  }
  /** Adds an outline to the open map: under the selected topic, else as a new tree. A new map starts from + New mind map. */
  openOutlineImport(prefill?: OutlineDraftPrefill): void {
    const target = prefill ? this.reopenedImportTarget(prefill.inputs) : this.outlineImportTarget();
    if (target.map !== "editable") {
      new Notice(target.map === "aim" ? t("ui.outline_import_placement_aim") : t("ui.outline_import_placement_no_map"));
      return;
    }
    const placement = prefill ? prefill.inputs.placement : target.selected ? "under" : "tree";
    new OutlineImportModal(
      this.app,
      request => this.importOutline(request),
      this.modelChoices(),
      this.templateChoices(),
      target,
      placement,
      this.outlineGenerator(prefill ? prefill.inputs.topic : target.selected?.title, prefill),
      this.fieldLinks(),
      this.toneChoices(),
      this.defaultStyleLabel(),
      parentId => this.outlineModelLabel(parentId)
    ).open();
  }
  /**
   * What the outline window's default model entry means at a position: new topics under a topic with a manual upper
   * topic follow that model, everything else follows the current model.
   */
  private async outlineModelLabel(parentId: string | null): Promise<string> {
    const parent = parentId ? this.map?.nodes.find(node => node.id === parentId) : undefined;
    const resolved = parent
      ? await this.plugin.repo.resolveTopicModel(parent.path, this.map ?? undefined)
      : { ...this.plugin.currentModelChoice(), origin: "current" as const };
    return t(
      resolved.origin === "override" ? "ui.follow_parent_topic_0" : "ui.follow_current_model_0",
      this.plugin.modelLabel(resolved.model)
    );
  }
  /** The import target a reopened window keeps: its selected topic while that topic is still on the map. */
  private reopenedImportTarget(inputs: OutlineDraftInputs): OutlineImportTarget {
    const current = this.outlineImportTarget();
    const selected = inputs.target.selected;
    if (current.map !== "editable" || !selected) return current;
    const node = this.map?.nodes.find(item => item.id === selected.id);
    return node
      ? { map: "editable", selected: { id: node.id, title: this.notes.get(node.id)?.title ?? node.path } }
      : { map: "editable" };
  }
  /**
   * The AI outline generator for the import window: workspace model, after the usual AI usage check. Once AI starts
   * the window hides itself and this view owns the run (status bar with Stop); the result waits there for review.
   */
  private outlineGenerator(initialTopic?: string, prefill?: OutlineDraftPrefill): OutlineGenerator {
    return {
      presets: this.plugin,
      initialTopic,
      ...(prefill ? { prefill } : {}),
      generate: async (request, signal, started) => {
        if (this.outlineDraftTask?.state === "running") throw new Error(t("ui.ai_running_ai"));
        const settings = this.plugin.settings;
        // The model menu's pick is for this generation only; the reasoning is the current model's (D5).
        const current = this.plugin.currentModelChoice();
        // Under a topic the default follows that topic's manual model (as the window's default entry says); the
        // reasoning stays the current model's. A new tree or a parent with no manual model uses the current model.
        const parent =
          request.placement?.kind === "under"
            ? this.map?.nodes.find(node => node.id === (request.placement as { parentId: string }).parentId)
            : undefined;
        const inherited = parent ? await this.plugin.repo.resolveTopicModel(parent.path, this.map ?? undefined) : null;
        const { model, reasoning } = resolveTaskModel({
          runOnce: request.model ? { model: request.model } : null,
          override: inherited?.origin === "override" ? { model: inherited.model, reasoning: current.reasoning } : null,
          current
        });
        const { placement: _placement, ...forService } = request;
        void _placement;
        const controller = new AbortController();
        // Closing the window before AI starts (usage notice still open) stops the run; after that only Stop does.
        const forward = (): void => controller.abort();
        signal.addEventListener("abort", forward, { once: true });
        const run: { task?: NonNullable<VisualAgentMapView["outlineDraftTask"]> } = {};
        const ran = await this.plugin.confirmAiUsage(model, async () => {
          if (signal.aborted) return;
          const inputs = started();
          signal.removeEventListener("abort", forward);
          const own: NonNullable<VisualAgentMapView["outlineDraftTask"]> = {
            mapPath: this.path,
            controller,
            state: "running",
            inputs
          };
          run.task = own;
          this.outlineDraftTask = own;
          if (!this.closed) this.render();
          try {
            const result = await this.plugin.outlineGeneration.generate(
              {
                ...forService,
                language: settings.language,
                contentLanguage: outputLanguageForMap(this.map, settings.language, request.topic),
                model,
                reasoning
              },
              controller.signal
            );
            // Stopped, replaced or the view closed meanwhile: the late result is dropped.
            if (controller.signal.aborted || this.outlineDraftTask !== own || this.closed) return;
            own.state = "done";
            own.markdown = result.markdown;
            backgroundResultNotice(t("ui.outline_ai_ready"), {
              label: t("ui.background_review"),
              open: () => this.reopenOutlineDraft(own)
            });
          } catch (error) {
            if (controller.signal.aborted || this.outlineDraftTask !== own || this.closed) return;
            own.state = "failed";
            own.message = errorMessage(error);
            new Notice(own.message);
          }
          if (!this.closed) this.render();
        });
        signal.removeEventListener("abort", forward);
        if (!ran || !run.task) throw new Error(t("ui.outline_ai_not_started"));
        return run.task.markdown ?? "";
      }
    };
  }
  /** Reopens the import window from a finished, failed or stopped AI outline; the waiting task is consumed. */
  private reopenOutlineDraft(task: NonNullable<VisualAgentMapView["outlineDraftTask"]>): void {
    if (this.outlineDraftTask !== task || task.state === "running" || this.closed) return;
    this.outlineDraftTask = null;
    this.render();
    this.openOutlineImport({
      inputs: task.inputs,
      ...(task.state === "done" && task.markdown !== undefined
        ? { markdown: task.markdown }
        : { message: task.message ?? t("ui.outline_ai_stopped") })
    });
  }
  /** The status bars for background AI work on the open map: structure review and AI outline generation. */
  private renderBackgroundBars(parent: HTMLElement): void {
    const review = this.structureReviewTask;
    if (review && review.mapPath === this.path) {
      const running = review.state === "running";
      const count = review.result?.suggestions.length ?? 0;
      renderBackgroundStatus(parent, {
        title: t(review.scopeId ? "ui.structure_review_branch" : "ui.structure_review_map"),
        value: running
          ? t("ui.structure_review_running")
          : review.state === "done"
            ? t("ui.structure_review_ready_0", count)
            : (review.message ?? ""),
        running,
        ...(running ? { onStop: () => this.stopStructureReview(review) } : {}),
        ...(review.state === "done" && review.result
          ? {
              review: {
                label: t("ui.structure_review_view_0", count),
                open: () => this.reopenStructureReview(review)
              }
            }
          : {}),
        onDismiss: () => {
          if (this.structureReviewTask === review) this.structureReviewTask = null;
          this.render();
        }
      });
    }
    const draft = this.outlineDraftTask;
    if (draft && draft.mapPath === this.path) {
      const running = draft.state === "running";
      renderBackgroundStatus(parent, {
        title: t("ui.outline_ai_generate"),
        value: running
          ? t("ui.outline_ai_running")
          : draft.state === "done"
            ? t("ui.outline_ai_bar_ready")
            : (draft.message ?? t("ui.outline_ai_stopped")),
        running,
        ...(running
          ? {
              onStop: () => {
                draft.state = "stopped";
                draft.controller.abort();
                this.render();
              }
            }
          : { review: { label: t("ui.background_review"), open: () => this.reopenOutlineDraft(draft) } }),
        onDismiss: () => {
          if (this.outlineDraftTask === draft) this.outlineDraftTask = null;
          this.render();
        }
      });
    }
    const merge = this.mergeTasks.get(this.path);
    if (merge) {
      const names = merge.sources.map(source => this.notes.get(source.id)?.title ?? source.path);
      renderBackgroundStatus(parent, {
        title: t("ui.merge_bar_title"),
        value: names.join(t("ui.list_separator")),
        running: true,
        ...(merge.state === "running"
          ? {
              onStop: () => this.stopMergeTask(merge),
              stopLabel: t("ui.merge_stop"),
              detail: bar => this.renderTaskProgress(bar, parent, this.taskProgressKey("merge", merge.mapPath))
            }
          : {})
      });
    }
  }
  /** Quick explore in the Next Step dialog: the same generator, reviewed in the dialog, then added under the topic. */
  private quickOutline(node: MapNode): QuickOutline {
    const settings = this.plugin.settings;
    return {
      presets: listPresets(settings.promptPresets, "outline", settings.language).map(({ id, name }) => ({ id, name })),
      generate: async (request, signal): Promise<OutlineNode[]> => {
        const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
        const { preset } = resolvePreset(settings.promptPresets, "outline", request.presetId, request.language);
        const used = await this.modelFor(note, node.path, request.runOnce);
        const result = await this.plugin.outlineGeneration.generate(
          {
            topic: note.title,
            presetText: request.requirements ? `${preset.text}\n\n${request.requirements}` : preset.text,
            language: request.language,
            model: used.model,
            reasoning: normalizeReasoningLevel(used.reasoning ?? settings.cliReasoning),
            limits: request.limits
          },
          signal
        );
        return result.nodes;
      },
      create: (nodes, options) =>
        this.importOutline({
          nodes,
          placement: { kind: "under", parentId: node.id },
          source: null,
          shallowResearch: !!options.shallowResearch,
          researchEveryTopic: true,
          // The research of the new topics is the short overview in the dialog's AI mode (Quick when it has none).
          ...(options.shallowResearch
            ? {
                aiMode: options.mapAiMode ?? ("quick" as const),
                researchOptions: {
                  referenceGroups: options.referenceGroups ?? [],
                  ...(options.outputLanguage ? { outputLanguage: options.outputLanguage } : {}),
                  ...(options.toneId ? { toneId: options.toneId } : {}),
                  ...(options.requirements ? { requirements: options.requirements } : {})
                }
              }
            : {}),
          ...(options.detailTemplateId ? { detailTemplateId: options.detailTemplateId } : {})
        })
    };
  }
  /** 「檢視整張圖」 on a root topic, 「檢視這個分支」 on a subtopic with subtopics; nothing on a leaf or an AIM map. */
  private structureReviewEntry(node: MapNode): { label: string; open: () => void } | undefined {
    if (!this.map || this.outlineImportTarget().map !== "editable") return undefined;
    if (node.parentId === null)
      return { label: t("ui.structure_review_entry_map"), open: () => this.openStructureReview(null) };
    if (this.map.nodes.some(item => item.parentId === node.id))
      return { label: t("ui.structure_review_entry_branch"), open: () => this.openStructureReview(node.id) };
    return undefined;
  }
  /** What the Next Step dialog offers; nothing while the entry is hidden (`STRUCTURE_REVIEW_ENTRY_SHOWN`). */
  private nextStepStructureReview(node: MapNode): { label: string; open: () => void } | undefined {
    return STRUCTURE_REVIEW_ENTRY_SHOWN ? this.structureReviewEntry(node) : undefined;
  }
  /** The AI sees each card's title, summary and status only; never a note body. */
  private describeForReview(id: string): { title: string; summary: string; status: string } | undefined {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!node) return undefined;
    const note = this.notes.get(id);
    return { title: note?.title ?? node.path, summary: note?.summary ?? "", status: note?.status ?? "idea" };
  }
  /** AI structure review of the whole map (`scopeId` null) or one branch; each suggestion is applied on its own. */
  openStructureReview(scopeId: string | null): void {
    if (!this.map || this.outlineImportTarget().map !== "editable") return;
    const existing = this.structureReviewTask;
    if (existing && existing.mapPath === this.path) {
      // One background review at a time; a finished one for this scope reopens instead of starting again.
      if (existing.state === "running") {
        new Notice(t("ui.ai_running_ai"));
        return;
      }
      if (existing.state === "done" && existing.scopeId === scopeId) {
        this.reopenStructureReview(existing);
        return;
      }
    }
    const mapPath = this.path;
    const tree = (): ReturnType<typeof buildStructureReviewNodes> =>
      this.path === mapPath && this.map
        ? buildStructureReviewNodes(this.map.nodes, id => this.describeForReview(id), scopeId)
        : [];
    const nodes = tree();
    const rootQuestion = scopeId ? (this.describeForReview(scopeId)?.title ?? "") : this.map.title;
    const staleReason = (suggestion: StructureSuggestion): string | null => {
      const current = tree();
      if (!isSuggestionStale(suggestion, current)) return null;
      const byId = new Map(current.map(item => [item.id, item]));
      const target = byId.get(suggestion.targetId);
      const destination = suggestion.newParentId ?? suggestion.mergeIntoId;
      if (!target || (destination && !byId.has(destination))) return t("ui.structure_review_stale_missing");
      if (target.title !== suggestion.basis.targetTitle || target.parentId !== suggestion.basis.targetParentId)
        return t("ui.structure_review_stale_changed");
      return t("ui.structure_review_stale_structure");
    };
    const showWindow = (
      extra: Partial<ConstructorParameters<typeof StructureReviewModal>[1]> & {
        review: ConstructorParameters<typeof StructureReviewModal>[1]["review"];
      }
    ): void =>
      new StructureReviewModal(this.app, {
        scope: scopeId ? "branch" : "map",
        titleOf: id => this.describeForReview(id)?.title ?? "",
        staleReason,
        apply: (suggestion, title) => this.applyStructureSuggestion(suggestion, title, staleReason),
        highlight: ids => this.highlightStructure(ids),
        ...extra
      }).open();
    const reopen = (
      result: StructureReviewResult,
      task: NonNullable<VisualAgentMapView["structureReviewTask"]>
    ): void =>
      showWindow({
        review: async () => result,
        initial: result,
        consumed: () => {
          if (this.structureReviewTask === task) this.structureReviewTask = null;
          if (!this.closed) this.render();
        }
      });
    showWindow({
      review: async (signal, started) => {
        const settings = this.plugin.settings;
        const { model, reasoning } = this.plugin.currentModelChoice();
        const controller = new AbortController();
        // Closing the window before AI starts (usage notice still open) cancels; after that only Stop does.
        const forward = (): void => controller.abort();
        signal.addEventListener("abort", forward, { once: true });
        const run: { began: boolean } = { began: false };
        await this.plugin.confirmAiUsage(model, async () => {
          if (signal.aborted) return;
          run.began = true;
          signal.removeEventListener("abort", forward);
          const own: NonNullable<VisualAgentMapView["structureReviewTask"]> = {
            mapPath,
            scopeId,
            controller,
            state: "running",
            reopen: result => reopen(result, own)
          };
          this.structureReviewTask = own;
          if (!this.closed) this.render();
          started();
          try {
            const review = await this.plugin.structureReview.review(
              {
                rootQuestion,
                nodes,
                language: settings.language,
                contentLanguage: outputLanguageForMap(this.map, settings.language, rootQuestion),
                model,
                reasoning
              },
              controller.signal
            );
            // Stopped, replaced or the view closed meanwhile: the late result is dropped.
            if (controller.signal.aborted || this.structureReviewTask !== own || this.closed) return;
            own.state = "done";
            own.result = review;
            backgroundResultNotice(t("ui.structure_review_ready_0", review.suggestions.length), {
              label: t("ui.structure_review_view_0", review.suggestions.length),
              open: () => this.reopenStructureReview(own)
            });
          } catch (error) {
            if (controller.signal.aborted || this.structureReviewTask !== own || this.closed) return;
            own.state = "failed";
            own.message = errorMessage(error);
            new Notice(own.message);
          }
          if (!this.closed) this.render();
        });
        signal.removeEventListener("abort", forward);
        if (!run.began) throw new Error(t("ui.structure_review_not_started"));
        // The window already hid itself; the result lives on the status bar.
        return { suggestions: [], rejected: [] };
      }
    });
  }
  /** Opens the window on a finished review's suggestions (no Start); closing it drops the waiting result. */
  private reopenStructureReview(task: NonNullable<VisualAgentMapView["structureReviewTask"]>): void {
    if (this.structureReviewTask !== task || task.state !== "done" || !task.result || this.closed) return;
    task.reopen(task.result);
  }
  /** Stop on the status bar: the run is aborted and forgotten, so its late result changes nothing. */
  private stopStructureReview(task: NonNullable<VisualAgentMapView["structureReviewTask"]>): void {
    if (this.structureReviewTask === task) this.structureReviewTask = null;
    task.controller.abort();
    this.render();
  }
  /** Marks the suggested cards in place; an empty list clears every mark. */
  highlightStructure(ids: string[]): void {
    const next = new Set(ids);
    for (const id of new Set([...this.structureHighlight, ...next]))
      this.cardEls.get(id)?.toggleClass("vam-structure-suggested", next.has(id));
    this.structureHighlight = next;
  }
  // ---- Relevance grading: goal chip, status bar and change summary ----------------------------------------------
  /** Mind maps only: not the built-in sample and not an AIM map. */
  private relevanceGradeable(): boolean {
    return !this.builtIn && !!this.map && !this.map.aim && !!this.path;
  }
  /**
   * One toolbar button, the same level as "Select topics": it shows the goal and opens a panel under it with the goal,
   * level, context, a "Grade with this" button and the display-only sort switch.
   */
  private renderRelevanceGoalControl(parent: HTMLElement): void {
    // A repaint drops the old DOM: stop its listeners and make sure its late focus events cannot close the new panel.
    this.relevancePanelGen++;
    this.relevancePanelCleanup?.();
    this.relevancePanelCleanup = null;
    this.relevancePanelEl = null;
    this.relevanceToolsEl = parent;
    this.drawRelevanceButton(parent);
    if (!this.relevancePanelOpen) return;
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") {
      this.relevancePanelOpen = false;
      this.relevanceDraft = null;
      this.relevanceButtonEl?.setAttr("aria-expanded", "false");
      return;
    }
    this.drawRelevancePanel(false);
  }
  private relevanceLevelLabel(level: RelevanceLevel | undefined): string {
    return t(`ui.relevance_level_${level ?? "none"}`);
  }
  /** Display-only toggle: within each sibling group show core, support, side, then ungraded. */
  private relevanceSortOn(): boolean {
    return this.relevanceGradeable() && relevanceSortedMaps.has(this.path);
  }
  private drawRelevanceButton(parent: HTMLElement): void {
    const goal = this.relevanceGoal;
    const level = this.relevanceLevel;
    const sorted = this.relevanceSortOn();
    const label = goal
      ? level
        ? t("ui.relevance_goal_level_0_1", goal, this.relevanceLevelLabel(level))
        : t("ui.relevance_goal_0", goal)
      : t("ui.relevance_goal_set");
    const button = this.button(parent, label, () => {
      if (this.relevancePanelOpen && this.relevancePanelEl) this.closeRelevancePanel(true);
      else this.editRelevanceGoal();
    });
    button.addClass("vam-relevance-goal");
    button.toggleClass("is-empty", !goal);
    button.toggleClass("is-sorted", sorted);
    button.setAttr("aria-haspopup", "dialog");
    button.setAttr("aria-expanded", String(this.relevancePanelOpen));
    button.setAttr("aria-controls", this.relevancePanelId);
    button.setAttr("aria-description", t(goal ? "ui.relevance_goal_edit_hint" : "ui.relevance_goal_set_hint"));
    setTooltip(
      button,
      goal ? [label, this.relevanceContext].filter(Boolean).join("\n") : t("ui.relevance_goal_set_hint")
    );
    // The tooltip helper makes the goal alone the accessible name; keep the "Goal:" label a screen reader needs.
    button.setAttr("aria-label", sorted ? `${label}${t("ui.relevance_sorted_suffix")}` : label);
    button.disabled = this.plugin.relevanceGrades.get(this.path)?.status === "running";
    // Pressing the button must not move focus out of an open panel (that would count as leaving it).
    button.addEventListener("mousedown", event => event.preventDefault());
    // Focus leaving the button (Shift+Tab off it, or a click elsewhere) to outside the panel closes the panel too.
    button.addEventListener("focusout", (event: FocusEvent) => {
      if (!this.relevancePanelOpen || this.relevanceButtonEl !== button) return;
      const next = event.relatedTarget as Node | null;
      if (next && (next === button || this.relevancePanelEl?.contains(next))) return;
      this.closeRelevancePanel(false);
    });
    button.addEventListener("keydown", event => {
      if (event.key !== "Escape" || !this.relevancePanelOpen || this.relevanceButtonEl !== button) return;
      event.preventDefault();
      event.stopPropagation();
      this.closeRelevancePanel(true);
    });
    if (sorted) {
      const icon = button.createSpan("vam-relevance-sort-icon");
      icon.setAttr("aria-hidden", "true");
      setIcon(icon, "arrow-down-wide-narrow");
    }
    this.relevanceButtonEl = button;
  }
  /**
   * Starts the Claude CLI for the grade the open panel would run (no model call; a Codex model starts nothing). The
   * very same command the run uses, so sending only has to write the prompt.
   */
  private prewarmRelevance(mode: RelevanceMode): void {
    const { model, reasoning } = this.plugin.currentModelChoice();
    this.plugin.prewarmClaudeStep?.(
      model,
      reasoning,
      mode === "recalibrate" ? RELEVANCE_RECALIBRATE_SCHEMA : RELEVANCE_GRADE_SCHEMA
    );
  }
  /** `keepWarm`: the panel closes to send, so the pre-started process stays for that run; otherwise it is killed. */
  private closeRelevancePanel(refocus: boolean, keepWarm = false): void {
    if (!keepWarm) this.plugin.releaseWarmClaude?.();
    this.relevancePanelGen++;
    this.relevancePanelCleanup?.();
    this.relevancePanelCleanup = null;
    this.relevancePanelEl?.remove();
    this.relevancePanelEl = null;
    this.relevancePanelOpen = false;
    this.relevanceDraft = null;
    this.relevanceButtonEl?.setAttr("aria-expanded", "false");
    if (refocus && !this.relevanceButtonEl?.disabled) this.relevanceButtonEl?.focus();
  }
  /** Open the goal panel under the toolbar button (no-op while a grading run is going). */
  private editRelevanceGoal(): void {
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") {
      new Notice(t("ui.relevance_goal_unavailable_grading"));
      return;
    }
    if (!this.relevanceToolsEl) {
      new Notice(t("ui.relevance_goal_unavailable_toolbar"));
      return;
    }
    this.relevancePanelOpen = true;
    this.relevanceDraft = {
      goal: this.relevanceGoal ?? "",
      level: this.relevanceLevel ?? "",
      context: this.relevanceContext ?? ""
    };
    this.relevanceButtonEl?.setAttr("aria-expanded", "true");
    this.drawRelevancePanel(true);
  }
  /**
   * The panel holds one group: goal, level, context and a "Grade with this" button, then the sort switch. Enter in a
   * text field or the button confirms; Esc, a press outside, or focus leaving the panel closes it without submitting.
   * Tab inside the panel does not. The sort switch does not close it.
   */
  private drawRelevancePanel(focus: boolean): void {
    const tools = this.relevanceToolsEl;
    if (!tools) return;
    this.relevancePanelEl?.remove();
    const gen = ++this.relevancePanelGen;
    const draft = (this.relevanceDraft ??= {
      goal: this.relevanceGoal ?? "",
      level: this.relevanceLevel ?? "",
      context: this.relevanceContext ?? ""
    });
    const panel = tools.createDiv({
      cls: "vam-relevance-panel",
      attr: { id: this.relevancePanelId, role: "dialog", "aria-label": t("ui.relevance_panel_label") }
    });
    this.relevancePanelEl = panel;
    const group = panel.createDiv({
      cls: "vam-relevance-setup",
      attr: { role: "group", "aria-label": t("ui.relevance_goal_label") }
    });
    const input = group.createEl("input", { cls: "vam-relevance-goal-input", type: "text" });
    input.value = draft.goal;
    input.maxLength = RELEVANCE_GOAL_MAX_LENGTH;
    input.setAttr("aria-label", t("ui.relevance_goal_label"));
    input.setAttr("placeholder", t("ui.relevance_goal_placeholder"));
    const row = group.createDiv("vam-relevance-setup-row");
    const levelSelect = row.createEl("select", { cls: "dropdown vam-relevance-level" });
    levelSelect.setAttr("aria-label", t("ui.relevance_level_label"));
    for (const value of ["", ...RELEVANCE_LEVELS])
      levelSelect.createEl("option", { text: this.relevanceLevelLabel(normalizeRelevanceLevel(value)), value });
    levelSelect.value = draft.level;
    const context = row.createEl("input", { cls: "vam-relevance-context-input", type: "text" });
    context.value = draft.context;
    context.maxLength = RELEVANCE_CONTEXT_MAX_LENGTH;
    context.setAttr("aria-label", t("ui.relevance_context_label"));
    context.setAttr("placeholder", t("ui.relevance_context_placeholder"));
    // One button; its words follow the mode the click would run in (the same pure check the click uses).
    const pinCount = this.relevancePinList().length;
    const planMode = (): RelevanceMode =>
      relevanceMode(
        { goal: input.value, level: levelSelect.value, context: context.value },
        { goal: this.relevanceGoal, level: this.relevanceLevel, context: this.relevanceContext },
        this.relevanceAiGrades().length > 0
      );
    const submitButton = group.createEl("button", {
      cls: "vam-relevance-grade-button mod-cta",
      text: t(planMode() === "recalibrate" ? "ui.relevance_recalibrate_button" : "ui.relevance_grade_button")
    });
    // Opening the panel pre-starts the CLI for the grade it would run; changing the mode (full or recalibrate) changes
    // the schema, so the process is started again for the new mode.
    let warmedMode = planMode();
    if (focus && this.relevanceGradeable()) this.prewarmRelevance(warmedMode);
    const showMode = (): void => {
      const mode = planMode();
      submitButton.setText(t(mode === "recalibrate" ? "ui.relevance_recalibrate_button" : "ui.relevance_grade_button"));
      if (mode !== warmedMode) {
        warmedMode = mode;
        if (this.relevanceGradeable()) this.prewarmRelevance(mode);
      }
    };
    input.addEventListener("input", () => {
      draft.goal = input.value;
      showMode();
    });
    context.addEventListener("input", () => {
      draft.context = context.value;
      showMode();
    });
    levelSelect.addEventListener("change", () => {
      draft.level = levelSelect.value;
      showMode();
    });
    let unpinAllButton: HTMLButtonElement | undefined;
    if (pinCount) {
      const pinsRow = panel.createDiv("vam-relevance-pins-row");
      pinsRow.createSpan({ text: t("ui.relevance_pins_note_0", pinCount) });
      unpinAllButton = pinsRow.createEl("button", {
        cls: "vam-relevance-unpin-all",
        text: t("ui.relevance_unpin_all")
      });
    }
    // The sort switch: display only, an in-memory Set, no file write and no refit. It never closes the panel.
    panel.createDiv("vam-relevance-divider");
    const on = this.relevanceSortOn();
    const sort = panel.createEl("button", { cls: "vam-relevance-sort" });
    sort.setAttr("aria-pressed", String(on));
    const copy = sort.createSpan("vam-relevance-sort-copy");
    copy.createSpan({ cls: "vam-relevance-sort-title", text: t("ui.relevance_sort") });
    copy.createSpan({ cls: "vam-relevance-sort-hint", text: t("ui.relevance_sort_hint") });
    const knob = sort.createSpan({ cls: `checkbox-container vam-relevance-switch${on ? " is-enabled" : ""}` });
    knob.setAttr("aria-hidden", "true");
    sort.addEventListener("click", event => {
      event.stopPropagation();
      if (on) relevanceSortedMaps.delete(this.path);
      else relevanceSortedMaps.add(this.path);
      // Do not refit the view here: that saves the viewport into Map.md, and this toggle must write nothing.
      this.renderPreservingFocus();
    });
    let finished = false;
    const alive = (): boolean => !finished && gen === this.relevancePanelGen;
    // Confirm, Esc and leaving the panel close it; an empty goal never reaches the AI.
    const finish = (submit: boolean, refocus: boolean): void => {
      if (!alive()) return;
      finished = true;
      const value = input.value;
      const level = normalizeRelevanceLevel(levelSelect.value);
      const extra = context.value;
      const planned = planMode();
      this.closeRelevancePanel(refocus, submit && !!normalizeRelevanceGoal(value));
      if (submit) void this.submitRelevanceGoal(value, level, extra, planned);
    };
    const confirm = (): void => finish(true, !normalizeRelevanceGoal(input.value));
    const keys = (event: KeyboardEvent, enterConfirms: boolean): void => {
      event.stopPropagation();
      if (event.key === "Enter" && enterConfirms) {
        // Enter that confirms an IME composition (Chinese input) is not the field's Enter.
        if (event.isComposing) return;
        event.preventDefault();
        confirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        finish(false, true);
      }
    };
    input.addEventListener("keydown", event => keys(event, true));
    context.addEventListener("keydown", event => keys(event, true));
    levelSelect.addEventListener("keydown", event => keys(event, false));
    submitButton.addEventListener("keydown", event => keys(event, false));
    unpinAllButton?.addEventListener("keydown", event => keys(event, false));
    sort.addEventListener("keydown", event => keys(event, false));
    submitButton.addEventListener("click", event => {
      event.stopPropagation();
      confirm();
    });
    unpinAllButton?.addEventListener("click", event => {
      event.stopPropagation();
      finish(false, true);
      this.unpinAllRelevance();
    });
    unpinAllButton?.addEventListener("mousedown", event => event.preventDefault());
    // Keep focus where it is while the button is pressed, so the pointer press cannot count as leaving the panel.
    submitButton.addEventListener("mousedown", event => event.preventDefault());
    sort.addEventListener("mousedown", event => event.preventDefault());
    for (const control of [
      input,
      levelSelect,
      context,
      submitButton,
      ...(unpinAllButton ? [unpinAllButton] : []),
      sort
    ])
      control.addEventListener("focusout", (event: FocusEvent) => {
        // Only focus moving to a real element outside the panel closes it; null (a repaint, a dialog closing) does not.
        const next = event.relatedTarget as Node | null;
        if (next && !panel.contains(next) && next !== this.relevanceButtonEl) finish(false, false);
      });
    // A press anywhere else (the canvas, another card) closes it too; the toolbar button toggles it itself.
    const doc = this.contentEl?.ownerDocument;
    if (doc?.addEventListener) {
      const outside = (event: Event): void => {
        const target = event.target as Node | null;
        if (target && (panel.contains(target) || this.relevanceButtonEl?.contains(target))) return;
        finish(false, false);
      };
      doc.addEventListener("pointerdown", outside, true);
      this.relevancePanelCleanup = () => doc.removeEventListener("pointerdown", outside, true);
    }
    this.placeRelevancePanel(panel);
    if (focus) {
      input.focus();
      input.select();
    }
  }
  /** Keep the panel inside the map overlay: left-aligned under the button, shifted left when it would overflow. */
  private placeRelevancePanel(panel: HTMLElement): void {
    const button = this.relevanceButtonEl;
    const tools = this.relevanceToolsEl;
    const overlay = tools?.parentElement;
    if (!button?.getBoundingClientRect || !tools?.getBoundingClientRect || !overlay?.getBoundingClientRect) return;
    const bounds = overlay.getBoundingClientRect();
    const width = Math.max(0, Math.min(360, bounds.width - 32));
    const from = button.getBoundingClientRect().left;
    const left = Math.min(Math.max(from, bounds.left + 16), bounds.left + bounds.width - 16 - width);
    panel.style.width = `${width}px`;
    panel.style.left = `${left - tools.getBoundingClientRect().left - 1}px`;
  }
  private relevanceRunIsCurrent(run: RelevanceGradeRun, mapPath: string): boolean {
    return (
      !this.closed &&
      this.path === mapPath &&
      this.plugin.relevanceGrades.get(mapPath) === run &&
      run.status === "running" &&
      !run.controller.signal.aborted
    );
  }
  /** View closed or map switched: stop this view's run and forget it. A late result then fails every fence. */
  private abortRelevanceGrade(mapPath = this.path): void {
    if (!this.startedRelevance) return;
    const run = this.plugin.relevanceGrades.get(mapPath);
    if (!run || run.owner !== this) return;
    this.plugin.relevanceGrades.delete(mapPath);
    run.controller.abort();
  }
  private finishRelevance(
    run: RelevanceGradeRun,
    mapPath: string,
    status: "failed" | "declined",
    message: string
  ): void {
    if (!this.relevanceRunIsCurrent(run, mapPath)) return;
    this.plugin.releaseWarmClaude?.();
    run.received = undefined;
    run.status = status;
    run.message = message;
    this.refreshRelevance();
  }
  /**
   * Call before a repaint: when the keyboard is inside the relevance status bar, the returned function (call it after
   * the repaint) moves focus to what is left of it (its first button, else the goal chip) so it never falls to the page.
   */
  private keepRelevanceBarFocus(): () => void {
    const bar = this.contentEl?.querySelector?.<HTMLElement>(".vam-relevance-statusbar");
    const active = this.contentEl?.ownerDocument?.activeElement ?? null;
    if (!bar || !active || !bar.contains?.(active)) return () => {};
    return () => {
      const target =
        this.contentEl?.querySelector?.(".vam-relevance-statusbar")?.querySelector?.<HTMLElement>("button") ??
        this.contentEl?.querySelector?.<HTMLElement>(".vam-relevance-goal");
      target?.focus();
    };
  }
  /** Repaints the map and keeps the keyboard in the status bar when it had it (its buttons come and go). */
  private refreshRelevance(focusBar = false): void {
    if (this.closed) return;
    const bar = this.contentEl?.querySelector?.<HTMLElement>(".vam-relevance-statusbar");
    const hadFocus = !!bar && !!bar.contains?.(this.contentEl.ownerDocument?.activeElement ?? null);
    this.render();
    if (focusBar || hadFocus) this.contentEl?.querySelector?.<HTMLElement>(".vam-relevance-statusbar button")?.focus();
  }
  /**
   * Enter in the goal field. The goal is saved first (its own undo step), then, after the usage confirmation, the
   * whole map is graded and the result is written in one step. Nothing is written when the AI is declined, stopped,
   * fails or returns anything but exactly one valid grade for every card.
   */
  private async submitRelevanceGoal(
    raw: string,
    levelRaw?: RelevanceLevel,
    contextRaw?: string,
    planned: RelevanceMode = "full"
  ): Promise<void> {
    const goal = normalizeRelevanceGoal(raw);
    const level = normalizeRelevanceLevel(levelRaw);
    const context = contextRaw === undefined ? undefined : normalizeRelevanceContext(contextRaw);
    const mapPath = this.path;
    if (!goal || !this.relevanceGradeable()) return;
    if (this.plugin.relevanceGrades.get(mapPath)?.status === "running") return;
    const run: RelevanceGradeRun = {
      token: ++relevanceRunToken,
      owner: this,
      controller: new AbortController(),
      goal,
      status: "running",
      startedAt: Date.now()
    };
    // Claim the map before the first await, so a second Enter cannot start another run.
    this.plugin.relevanceGrades.set(mapPath, run);
    this.startedRelevance = true;
    // Stop, closing the view or switching maps before the run took the pre-started process leaves nothing waiting.
    run.controller.signal.addEventListener("abort", () => this.plugin.releaseWarmClaude?.(), { once: true });
    this.refreshRelevance(true);
    const settings = this.plugin.settings;
    let result: RelevanceGradeResult | undefined;
    let basis: StructureNode[] = [];
    let mode: RelevanceMode = planned;
    let pins: RelevancePin[] = [];
    const repairs: string[] = [];
    try {
      await this.plugin.mutate(async () => {
        const { previous, next, setupChanged } = await this.plugin.repo.writeRelevanceGoal(
          mapPath,
          goal,
          level,
          context
        );
        if (this.path !== mapPath) return;
        this.relevanceGoal = goal;
        this.relevanceLevel = level;
        this.relevanceContext = context;
        // The repository has the last word: a setup that changed after all is graded in full.
        mode = relevanceModeAfterWrite(planned, setupChanged);
        // The pre-started process was for the planned mode's schema; another mode starts cold.
        if (mode !== planned) this.plugin.releaseWarmClaude?.();
        // Goal, level and context are one undo step; none changed means nothing to undo.
        if (!setupChanged) return;
        this.history.push({
          label: t("ui.relevance_goal_history_label"),
          undo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, previous),
          redo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, next)
        });
        this.updateHistoryButtons();
      });
      const { model, reasoning: gradeReasoning } = this.plugin.currentModelChoice();
      // The run stays "running" (the map is locked and Stop works) but the bar must not claim grading while the
      // usage notice waits for an answer.
      // Only a notice that really opens needs the bar to say so; otherwise this is not repainted at all.
      if (this.plugin.usageNoticePending?.(model)) {
        run.awaitingUsage = true;
        this.refreshRelevance();
      }
      const started = await this.plugin.confirmAiUsage(model, async () => {
        // Stopped, or the map changed, while the usage dialog was open.
        if (!this.relevanceRunIsCurrent(run, mapPath) || !this.map) return;
        if (run.awaitingUsage) {
          run.awaitingUsage = false;
          // The seconds count the model's work, not the wait for the usage notice.
          run.startedAt = Date.now();
          this.refreshRelevance();
        }
        basis = buildStructureReviewNodes(this.map.nodes, id => this.describeForReview(id));
        // Pinned (hand-set) cards are the learner's: the AI sees them as anchors and never grades them.
        pins = this.relevancePinList();
        const request = {
          goal,
          ...(level ? { level } : {}),
          ...(context ? { context } : {}),
          nodes: basis,
          language: settings.language,
          model,
          reasoning: gradeReasoning,
          ...(pins.length ? { pins } : {})
        };
        const hooks = {
          onRepair: (_round: number, kind: string) => {
            repairs.push(kind);
            if (!this.relevanceRunIsCurrent(run, mapPath)) return;
            run.repairing = true;
            // A repair request answers from the start again.
            run.received = undefined;
            this.refreshRelevance();
          },
          // Text only: the count changes in place, the map is not repainted for it.
          onProgress: (progress: RelevanceReceived | null) => {
            if (!this.relevanceRunIsCurrent(run, mapPath)) return;
            run.received = progress ?? undefined;
            this.paintRelevanceReceived(run);
          }
        };
        result =
          mode === "recalibrate"
            ? await this.plugin.relevanceGrade.recalibrate(
                { ...request, previous: this.relevanceAiGrades() },
                run.controller.signal,
                hooks
              )
            : await this.plugin.relevanceGrade.grade(request, run.controller.signal, hooks);
      });
      if (!this.relevanceRunIsCurrent(run, mapPath)) return;
      if (!started) return this.finishRelevance(run, mapPath, "declined", t("ui.relevance_not_started"));
      const graded = result;
      if (!graded) return;
      // Writing the notes makes the view synchronize, which repaints when a note changed (the run is already "done"
      // by then); repaint here only when it did not, so a run costs one repaint after the write.
      const paintedBefore = this.paintCount;
      await this.plugin.mutate(() => this.applyRelevanceGrade(run, mapPath, basis, graded, { mode, pins, repairs }));
      if (this.paintCount === paintedBefore) this.refreshRelevance();
    } catch (error) {
      this.finishRelevance(run, mapPath, "failed", t("ui.relevance_failed_0", errorMessage(error)));
    }
  }
  /**
   * Writes the grades as one undo step. Each card is checked against what the AI was shown: a card deleted, renamed
   * or moved meanwhile is skipped (its old grade stays), and cards added meanwhile are not in the result so they stay
   * ungraded. A note that cannot be written is counted; the undo step covers only the notes actually written.
   */
  private async applyRelevanceGrade(
    run: RelevanceGradeRun,
    mapPath: string,
    basis: StructureNode[],
    graded: RelevanceGradeResult,
    meta: { mode: RelevanceMode; pins: RelevancePin[]; repairs: string[] }
  ): Promise<void> {
    if (!this.relevanceRunIsCurrent(run, mapPath) || !this.map) return;
    const items: RelevanceGradeItem[] = graded.items;
    run.writing = true;
    run.received = undefined;
    const startedAt = Date.now();
    const repo = this.plugin.repo;
    const fresh = new Map<string, Note>();
    for (const node of this.map.nodes) {
      try {
        fresh.set(node.id, await repo.readNote(node.path, this.map));
      } catch {
        /* A card whose note cannot be read counts as changed and is skipped below. */
      }
    }
    const current = new Map(
      buildStructureReviewNodes(this.map.nodes, id => {
        const note = fresh.get(id);
        return note ? { title: note.title, summary: "", status: "" } : undefined;
      }).map(node => [node.id, node])
    );
    const pathOf = new Map(this.map.nodes.map(node => [node.id, node.path]));
    const byId = new Map(items.map(item => [item.id, item]));
    const titleOf = new Map(basis.map(base => [base.id, base.title]));
    const pinned = new Set(meta.pins.map(pin => pin.id));
    const outcome: RelevanceGradeOutcome = {
      graded: 0,
      changes: [],
      skipped: 0,
      failed: 0,
      pinned: 0,
      mode: meta.mode,
      pins: meta.pins.map(pin => ({ id: pin.id, title: titleOf.get(pin.id) ?? "", tier: pin.tier })),
      conflicts: (graded.conflicts ?? []).map(conflict => ({
        ancestor: titleOf.get(conflict.ancestorId) ?? "",
        ancestorTier: conflict.ancestorTier,
        descendant: titleOf.get(conflict.descendantId) ?? "",
        descendantTier: conflict.descendantTier
      })),
      ...(graded.pinnedIgnored ? { pinnedIgnored: graded.pinnedIgnored } : {}),
      ...(graded.anchorsDropped ? { anchorsDropped: graded.anchorsDropped } : {}),
      ...(graded.unchangedIgnored ? { unchangedIgnored: graded.unchangedIgnored } : {})
    };
    try {
      for (const base of basis) {
        const item = byId.get(base.id);
        if (!item) continue;
        const now = current.get(base.id),
          note = fresh.get(base.id),
          path = pathOf.get(base.id);
        if (!now || !note || !path || now.title !== base.title || now.parentId !== base.parentId) {
          outcome.skipped++;
          continue;
        }
        if (note.relevance?.manual) {
          // A hand-set (pinned) card is never written by the AI, whatever the AI said.
          pinned.add(base.id);
          continue;
        }
        const after = { tier: item.tier };
        const before = note.relevance ? { tier: note.relevance.tier } : undefined;
        if (before && before.tier === after.tier) {
          outcome.graded++;
          continue;
        }
        try {
          await repo.writeRelevance(path, after);
          outcome.graded++;
          outcome.changes.push({
            id: base.id,
            path,
            title: note.title,
            before,
            after,
            ...(item.anchor ? { anchor: item.anchor } : {})
          });
        } catch (error) {
          outcome.failed++;
          this.plugin.logs.appendLog("error", t("log.operation_failed_0", errorMessage(error)));
        }
      }
    } finally {
      outcome.pinned = pinned.size;
      this.plugin.logs.appendLog(
        "info",
        `Relevance ${meta.mode}: repairs ${meta.repairs.length}${meta.repairs.length ? ` (${[...new Set(meta.repairs)].join(", ")})` : ""}, pinned ${pinned.size}, pinnedIgnored ${graded.pinnedIgnored ?? 0}, anchorsDropped ${graded.anchorsDropped ?? 0}, unchangedIgnored ${graded.unchangedIgnored ?? 0}, written ${outcome.changes.length}, failed ${outcome.failed}, skipped ${outcome.skipped}, ${Date.now() - startedAt} ms`
      );
      if (outcome.changes.length) {
        const changes = outcome.changes;
        const entry: Action = {
          label: t("ui.relevance_history_label"),
          undo: () => this.restoreRelevance(changes, "undo"),
          redo: () => this.restoreRelevance(changes, "redo")
        };
        this.history.push(entry);
        run.historyEntry = entry;
        this.updateHistoryButtons();
      }
      run.outcome = outcome;
      run.status = "done";
    }
  }
  /**
   * Undo or redo a grading run. A note is only put back when it still holds exactly what the run wrote (or, for redo,
   * what it replaced); a note the owner edited since is left alone and counted in a Notice.
   */
  private async restoreRelevance(changes: RelevanceGradeChange[], direction: "undo" | "redo"): Promise<void> {
    let skipped = 0;
    const same = (a: NoteRelevance | undefined, b: NoteRelevance | undefined): boolean =>
      a === b || (!!a && !!b && a.tier === b.tier && !!a.manual === !!b.manual);
    for (const change of changes) {
      const expected = direction === "undo" ? change.after : change.before;
      const replacement = direction === "undo" ? change.before : change.after;
      try {
        const latest = (await this.plugin.repo.readNote(change.path)).relevance;
        if (!same(latest, expected)) {
          skipped++;
          continue;
        }
        await this.plugin.repo.writeRelevance(change.path, replacement ?? null);
      } catch {
        skipped++;
      }
    }
    if (skipped) new Notice(t("ui.relevance_undo_skipped_0", skipped));
  }
  /**
   * The tag's menu: the three tiers (a check on the current one) and Clear grade. Disabled while a grading run is
   * in progress for this map, as the tag itself is.
   */
  private openRelevanceMenu(node: MapNode, current: RelevanceTier, anchor: HTMLElement): void {
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") return;
    const menu = new Menu();
    for (const tier of ["core", "support", "side"] as const)
      menu.addItem(item =>
        item
          .setTitle(t(RELEVANCE_LABEL[tier]))
          .setChecked(tier === current)
          .onClick(() => this.setManualRelevance(node, tier))
      );
    menu.addSeparator();
    menu.addItem(item => {
      item
        .setTitle(t("ui.relevance_clear"))
        .setIcon("x")
        .onClick(() => this.setManualRelevance(node, null));
      // The menu has no second line; the hint rides on the item as a tooltip where the host exposes its element.
      (item as unknown as { dom?: HTMLElement }).dom?.setAttribute?.("title", t("ui.relevance_clear_hint"));
    });
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }
  /** The gradable cards whose tier the learner set by hand (pinned), in map order, from the notes this view holds. */
  private relevancePinList(): RelevancePin[] {
    const pins: RelevancePin[] = [];
    for (const node of this.map?.nodes ?? []) {
      const relevance = node.parentId === null ? undefined : this.notes.get(node.id)?.relevance;
      if (relevance?.manual) pins.push({ id: node.id, tier: relevance.tier });
    }
    return pins;
  }
  /** The gradable cards with an AI tier (not pinned): what a recalibration starts from. */
  private relevanceAiGrades(): RelevancePin[] {
    const grades: RelevancePin[] = [];
    for (const node of this.map?.nodes ?? []) {
      const relevance = node.parentId === null ? undefined : this.notes.get(node.id)?.relevance;
      if (relevance && !relevance.manual) grades.push({ id: node.id, tier: relevance.tier });
    }
    return grades;
  }
  /**
   * Hands every pinned card back to the AI: the three relevance keys go, one mutation, one undo step. Undo puts the
   * pins back on cards that are still ungraded.
   */
  private unpinAllRelevance(): void {
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") return;
    const paths = new Map((this.map?.nodes ?? []).map(node => [node.id, node.path]));
    const entries = this.relevancePinList().flatMap(pin => {
      const path = paths.get(pin.id);
      return path ? [{ path, tier: pin.tier }] : [];
    });
    if (!entries.length) return;
    this.plugin.runMutation(async () => {
      const repo = this.plugin.repo;
      for (const entry of entries) await repo.writeRelevance(entry.path, null);
      this.history.push({
        label: t("ui.relevance_unpin_all_history_label"),
        undo: async () => {
          for (const entry of entries)
            if (!(await repo.readNote(entry.path)).relevance)
              await repo.writeRelevance(entry.path, { tier: entry.tier, manual: true });
        },
        redo: async () => {
          for (const entry of entries) {
            const latest = (await repo.readNote(entry.path)).relevance;
            if (latest?.manual && latest.tier === entry.tier) await repo.writeRelevance(entry.path, null);
          }
        }
      });
      this.updateHistoryButtons();
    });
  }
  /**
   * Sets a card's tier by hand (or clears it) in the note's frontmatter and repaints in place. No AI call, no parent-
   * child check, no viewport or Map.md write: only the three relevance keys of that one note change.
   */
  private setManualRelevance(node: MapNode, tier: RelevanceTier | null): void {
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") return;
    this.plugin.runMutation(() => this.plugin.repo.writeRelevance(node.path, tier ? { tier, manual: true } : null));
  }
  private stopRelevanceGrade(): void {
    const run = this.plugin.relevanceGrades.get(this.path);
    if (!run || run.status !== "running" || run.writing) return;
    run.status = "stopped";
    run.received = undefined;
    run.message = t("ui.relevance_stopped");
    run.controller.abort();
    this.refreshRelevance();
  }
  /** Status bar under the toolbar, same place and look as the AIM and multi-research bars. */
  private renderRelevanceStatus(parent: HTMLElement): void {
    const run = this.plugin.relevanceGrades.get(this.path);
    if (!run) return;
    const running = run.status === "running";
    const bar = parent.createDiv(`vam-aim-statusbar vam-relevance-statusbar${running ? " is-active" : ""}`);
    bar.setAttr("aria-live", "polite");
    bar.createSpan({ cls: "vam-aim-status-title", text: t("ui.relevance_history_label") });
    const outcome = run.outcome;
    const text = running
      ? t(
          run.awaitingUsage
            ? "ui.relevance_awaiting_usage"
            : run.repairing
              ? "ui.relevance_repairing"
              : "ui.relevance_running"
        )
      : run.status === "done" && outcome
        ? [
            this.relevanceDoneText(outcome),
            outcome.pinned && outcome.mode !== "recalibrate" ? t("ui.relevance_pinned_kept_0", outcome.pinned) : "",
            outcome.failed ? t("ui.relevance_write_failed_0", outcome.failed) : ""
          ]
            .filter(Boolean)
            .join(" ")
        : (run.message ?? "");
    const tone = running
      ? " vam-status-running"
      : run.status === "failed" || outcome?.failed
        ? " vam-status-error"
        : "";
    bar.createSpan({ cls: `vam-aim-status-value${tone}`, text });
    this.relevanceReceivedEl = null;
    if (running && !run.awaitingUsage && !run.writing) {
      // Both are hidden from screen readers (the bar is a live region and they change every few hundred ms or second).
      const received = bar.createSpan({ cls: "vam-relevance-received" });
      received.setAttr("aria-hidden", "true");
      this.relevanceReceivedEl = received;
      this.paintRelevanceReceived(run);
      if (run.startedAt !== undefined) {
        const elapsed = bar.createSpan({
          cls: "vam-research-elapsed vam-relevance-elapsed",
          text: this.researchElapsedText(run.startedAt)
        });
        elapsed.setAttr("aria-hidden", "true");
        this.trackResearchElapsed(elapsed, run.startedAt);
      }
    }
    if (running) {
      if (!run.writing) this.button(bar, t("ui.relevance_stop"), () => this.stopRelevanceGrade());
      return;
    }
    if (outcome?.changes.length || outcome?.conflicts?.length) {
      this.button(bar, t("ui.relevance_view_changes"), () => this.openRelevanceSummary(run));
      if (this.history.undoEntry && this.history.undoEntry === run.historyEntry)
        this.button(bar, t("ui.undo"), () => this.enqueue(() => this.travel(false)));
    }
    this.iconButton(bar, "x", t("ui.dismiss"), () => {
      this.plugin.relevanceGrades.delete(this.path);
      this.render();
      this.contentEl?.querySelector?.<HTMLElement>(".vam-relevance-goal")?.focus();
    });
  }
  /** Rewrites only the "N of M received" text; nothing is repainted. Empty (and hidden) until the first tier arrives. */
  private paintRelevanceReceived(run: RelevanceGradeRun): void {
    const element = this.relevanceReceivedEl;
    if (!element) return;
    const progress = run.received;
    const text = progress
      ? progress.total === undefined
        ? t("ui.relevance_received_changes_0", progress.received)
        : t("ui.relevance_received_0_1", progress.received, progress.total)
      : "";
    element.setText(text ? t("ui.aim_stage_with_elapsed_0_1", "", text) : "");
  }
  /** The status line of a finished run: a recalibration counts its moves against the pins; a full grade counts cards. */
  private relevanceDoneText(outcome: RelevanceGradeOutcome): string {
    if (outcome.mode !== "recalibrate")
      return t("ui.relevance_done_0_1_2", outcome.graded, outcome.changes.length, outcome.skipped);
    if (!outcome.changes.length) return t("ui.relevance_recalibrate_none");
    return outcome.pinned
      ? t("ui.relevance_recalibrated_0_1", outcome.pinned, outcome.changes.length)
      : t("ui.relevance_done_0_1_2", outcome.graded, outcome.changes.length, outcome.skipped);
  }
  private openRelevanceSummary(run: RelevanceGradeRun): void {
    const outcome = run.outcome;
    new RelevanceSummaryModal(this.app, {
      rows: (outcome?.changes ?? []).map(change => ({
        id: change.id,
        title: change.title,
        before: change.before,
        after: change.after,
        ...(change.anchor ? { anchor: change.anchor } : {})
      })),
      pins: outcome?.pins ?? [],
      conflicts: outcome?.conflicts ?? [],
      highlight: ids => this.highlightStructure(ids)
    }).open();
  }
  /**
   * Applies one structure suggestion as one undo step, after checking again that it still fits the map. Remove and
   * merge go through the delete confirmation; resolves false when it is cancelled.
   */
  private applyStructureSuggestion(
    suggestion: StructureSuggestion,
    title: string,
    staleReason: (suggestion: StructureSuggestion) => string | null
  ): Promise<boolean> {
    const guard = (): void => {
      const reason = staleReason(suggestion);
      if (reason) throw new Error(reason);
      const touched = [suggestion.targetId, suggestion.newParentId, suggestion.mergeIntoId];
      if (touched.some(id => !!id && this.isMerging(id))) {
        new Notice(t("ui.merge_locked"));
        throw new Error(t("ui.merge_locked"));
      }
    };
    const nodeOf = (id: string): MapNode => {
      const node = this.map?.nodes.find(item => item.id === id);
      if (!node) throw new Error(t("ui.structure_review_stale_missing"));
      return node;
    };
    try {
      guard();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const write = (work: () => Promise<void>): Promise<void> =>
      this.plugin.mutate(async () => {
        guard();
        await work();
      });
    if (suggestion.kind === "strengthen")
      return write(() => this.addNode(nodeOf(suggestion.targetId), title)).then(() => true);
    if (suggestion.kind === "move")
      return write(() => this.moveTopic(nodeOf(suggestion.targetId), nodeOf(suggestion.newParentId ?? ""))).then(
        () => true
      );
    return new Promise<boolean>((resolve, reject) => {
      const run = (work: () => Promise<void>): void => {
        write(work).then(() => resolve(true), reject);
      };
      const node = nodeOf(suggestion.targetId);
      if (suggestion.kind === "reduce") {
        this.confirmRemoveNode(node, { run, dismissed: () => resolve(false) });
        return;
      }
      const into = nodeOf(suggestion.mergeIntoId ?? "");
      const name = (item: MapNode): string => this.describeForReview(item.id)?.title ?? item.path;
      new ChoiceModal(
        this.app,
        t("ui.structure_review_merge_title", name(node), name(into)),
        t("ui.structure_review_merge_desc", name(node), name(into)),
        [
          {
            label: t("ui.structure_review_merge_confirm", name(node)),
            warning: true,
            action: () => run(() => this.removeToUnassigned(node, false, into.id))
          }
        ],
        () => resolve(false)
      ).open();
    });
  }
  /** Moves one topic and its branch under a new parent, in one undo step. */
  private async moveTopic(node: MapNode, parent: MapNode): Promise<void> {
    if (!this.mergeUnlocked([node.id, parent.id])) return;
    await this.mapChange(map => {
      if (!canParent(map.nodes, node.id, parent.id)) throw new Error(t("ui.circular_links_are_not_allowed"));
      map.nodes.find(item => item.id === node.id)!.parentId = parent.id;
      map.nodes.find(item => item.id === parent.id)!.collapsed = false;
      map.nodes = arrangeNewBranch(
        map.nodes,
        parent.id,
        new Set([node.id, ...descendants(map.nodes, node.id)]),
        this.cardHeightOf,
        undefined,
        layoutOf(map)
      );
    });
  }
  /** The side option on "+ Topic": one topic by default, or a pasted outline for several at once. */
  private openTopicMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle(t("ui.paste_outline_add_many"))
        .setIcon("list-tree")
        .onClick(() => this.openOutlineImport())
    );
    if (this.relationsEnabled())
      for (const kind of TOPIC_KINDS)
        menu.addItem(item =>
          item
            .setTitle(t(TOPIC_KIND_SHAPES[kind].labelKey))
            .setIcon(TOPIC_KIND_ICON[kind])
            .onClick(() => this.enqueue(() => this.addNode(null, undefined, true, true, kind)))
        );
    menu.showAtMouseEvent(event);
  }
  /** True when the topic note's frontmatter has `topic-cover: none` (read from the metadata cache only). */
  private topicCoverOff(node: MapNode): boolean {
    const file = this.app.vault.getAbstractFileByPath(node.path);
    const value: unknown =
      file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter?.["topic-cover"] : null;
    return typeof value === "string" && value.trim().toLowerCase() === "none";
  }
  /**
   * Turns a topic's card cover off (`topic-cover: none`) or back on (the key is removed) in one undoable step: the note
   * rewrite and Map.md (viewport only). Undo writes the old note text back, so the frontmatter is identical to before.
   */
  private async changeTopicCover(node: MapNode): Promise<TransactionEntry | null> {
    if (!this.map || !this.markersEditable(node)) return null;
    const off = this.topicCoverOff(node);
    const viewport = clone(this.map.viewport);
    const entry = await this.beginMapTransaction()
      .rewriteNote(node.path, async path => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(path);
        await this.app.vault.process(file, content => (off ? withoutCover(content) : withCoverOff(content)));
      })
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_cover") });
    this.history.push(entry);
    await this.refreshAfterSavedChange();
    return entry;
  }
  /** The six topic types as a menu; `pick` gets the chosen one. Used by the panel's "Add subtopic…". */
  private openKindMenu(event: MouseEvent, pick: (kind: TopicKind) => void): void {
    const menu = new Menu();
    for (const kind of TOPIC_KINDS)
      menu.addItem(item =>
        item
          .setTitle(t(TOPIC_KIND_SHAPES[kind].labelKey))
          .setIcon(TOPIC_KIND_ICON[kind])
          .onClick(() => pick(kind))
      );
    menu.showAtMouseEvent(event);
  }
  /** Collapse or expand every branch in one undoable change, then fit the map. `shownLevels` as in applyCollapseLevel. */
  private collapseTo(shownLevels: number | null): void {
    this.enqueue(async () => {
      if (!this.map) return;
      const preview = clone(this.map.nodes);
      applyCollapseLevel(preview, shownLevels);
      const changed = preview.some((node, index) => !!node.collapsed !== !!this.map!.nodes[index]?.collapsed);
      if (changed) {
        await this.mapChange(map => {
          applyCollapseLevel(map.nodes, shownLevels);
          map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
        });
        if (this.history.undoEntry) this.history.undoEntry.label = t("ui.collapse_levels");
        this.updateHistoryButtons();
      }
      this.fit();
    });
  }
  private autoLayout(): void {
    this.enqueue(() =>
      this.mapChange(map => {
        map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
      }, false)
    );
  }
  /**
   * Stores the map's arrangement and spacing and re-arranges the whole map in one undo step. A right map at standard
   * spacing leaves no `layout` field; a standard spacing is never stored.
   */
  private setLayout(patch: { direction?: LayoutKind; spacing?: LayoutSpacing }): void {
    this.enqueue(async () => {
      if (!this.map || this.map.aim || this.builtIn) return;
      const before = layoutOf(this.map);
      const direction = patch.direction ?? before.direction;
      const spacing = patch.spacing ?? before.spacing ?? "standard";
      await this.mapChange(map => {
        if (direction === "right" && spacing === "standard") delete map.layout;
        else map.layout = spacing === "standard" ? { direction } : { direction, spacing };
        // A branch layout that points against the new direction would be dropped on the next parse; drop it now.
        cleanBranchLayouts(map.nodes, direction);
        // A new balanced map deals the topics out again instead of keeping the sides they stand on.
        map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map), {
          reset: direction === "balanced" && before.direction !== "balanced"
        });
        // A balanced map decides each topic's side while arranging, so check once more with the new sides.
        if (direction === "balanced") cleanBranchLayouts(map.nodes, direction);
      }, false);
      this.fit();
    });
  }
  /** The zoom cluster's Layout menu: collapse or expand levels, then re-arrange the whole map. */
  private openLayoutMenu(event: MouseEvent): void {
    const menu = new Menu();
    const choices: { title: string; icon: string; levels: number | null }[] = [
      { title: t("ui.collapse_all"), icon: "chevrons-down-up", levels: 0 },
      { title: t("ui.expand_all"), icon: "chevrons-up-down", levels: null },
      ...[1, 2, 3].map(level => ({ title: t("ui.expand_to_level_0", level), icon: "list-tree", levels: level }))
    ];
    for (const choice of choices)
      menu.addItem(item =>
        item
          .setTitle(choice.title)
          .setIcon(choice.icon)
          .onClick(() => this.collapseTo(choice.levels))
      );
    menu.addSeparator();
    // An AIM map and the built-in sample always grow to the right.
    if (this.map && !this.map.aim && !this.builtIn) {
      const current = layoutOf(this.map);
      const directions: { direction: LayoutKind; title: string; icon: string }[] = [
        { direction: "right", title: t("ui.layout_direction_right"), icon: "arrow-right" },
        { direction: "left", title: t("ui.layout_direction_left"), icon: "arrow-left" },
        { direction: "down", title: t("ui.layout_direction_down"), icon: "arrow-down" },
        { direction: "up", title: t("ui.layout_direction_up"), icon: "arrow-up" },
        { direction: "balanced", title: t("ui.layout_direction_balanced"), icon: "move-horizontal" },
        { direction: "radial", title: t("ui.layout_direction_radial"), icon: "orbit" },
        { direction: "timeline", title: t("ui.layout_direction_timeline"), icon: "git-commit-horizontal" },
        { direction: "fishbone", title: t("ui.layout_direction_fishbone"), icon: "fish" }
      ];
      for (const choice of directions)
        menu.addItem(item =>
          item
            .setTitle(choice.title)
            .setIcon(choice.icon)
            .setChecked(choice.direction === current.direction)
            .onClick(() => this.setLayout({ direction: choice.direction }))
        );
      menu.addSeparator();
      const spacings: { spacing: LayoutSpacing; title: string }[] = [
        { spacing: "compact", title: t("ui.layout_spacing_compact") },
        { spacing: "standard", title: t("ui.layout_spacing_standard") },
        { spacing: "spacious", title: t("ui.layout_spacing_spacious") }
      ];
      for (const choice of spacings)
        menu.addItem(item =>
          item
            .setTitle(choice.title)
            .setIcon("move-vertical")
            .setChecked(choice.spacing === (current.spacing ?? "standard"))
            .onClick(() => this.setLayout({ spacing: choice.spacing }))
        );
    }
    menu.addItem(item =>
      item
        .setTitle(t("ui.auto_layout"))
        .setIcon("workflow")
        .onClick(() => this.autoLayout())
    );
    menu.showAtMouseEvent(event);
  }
  /** The tab's "More options" menu: export the open map as OPML or FreeMind. Reading only, so a read-only map may use it. */
  override onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    if (!this.map || this.builtIn || !this.path) return;
    menu.addSeparator();
    for (const [format, key] of [
      ["opml", "ui.exchange_export_opml"],
      ["freemind", "ui.exchange_export_freemind"]
    ] as const)
      menu.addItem(item =>
        item
          .setTitle(t(key))
          .setIcon("file-output")
          .onClick(() => this.exportExchange(format))
      );
  }
  /** Writes the open map as OPML or FreeMind next to its Map.md. */
  private exportExchange(format: "opml" | "freemind"): void {
    const map = this.map;
    if (!map || this.builtIn || !this.path) return;
    void exportMapWithNotice(this.app.vault, { mapPath: this.path, map, notes: this.notes, format });
  }
  /** Whether the open map can take an imported outline, and the selected topic for "under the selected topic". */
  private outlineImportTarget(): OutlineImportTarget {
    if (!this.map || this.builtIn || !isManagedMapPath(this.plugin.settings, this.path)) return { map: "none" };
    if (this.map.aim) return { map: "aim" };
    const node = this.map.nodes.find(item => item.id === this.selected);
    if (!node) return { map: "editable" };
    return { map: "editable", selected: { id: node.id, title: this.notes.get(node.id)?.title ?? node.path } };
  }
  async importOutline(request: OutlineImportRequest): Promise<void> {
    const placement = request.placement ?? { kind: "new" };
    if (placement.kind !== "new") return this.importOutlineIntoMap(request, placement);
    // A model chosen for the shallow research becomes the new topics' model, so later work on them uses it too.
    const currentModel = this.plugin.currentModelChoice().model;
    const model = (request.shallowResearch && request.model) || currentModel;
    const settings = this.plugin.settings;
    const { template } = resolveTemplate(
      settings.detailTemplates,
      [request.detailTemplateId, settings.defaultDetailTemplateId],
      noteLanguageOf(settings.language)
    );
    let result: Awaited<ReturnType<typeof createOutlineMap>>;
    try {
      result = await createOutlineMap(
        this.plugin.repo,
        model,
        request.nodes,
        request.source,
        undefined,
        template,
        Boolean(request.shallowResearch && request.model && request.model !== currentModel)
      );
    } catch (error) {
      // Once the map folder exists the import window must close, so a retry cannot create a second map.
      if (!(error as { mapCreated?: unknown } | null)?.mapCreated) throw error;
      new Notice(errorMessage(error));
      return;
    }
    // From here on the map exists: failures only notify and never reject, so the import window closes.
    let opened = true;
    try {
      await this.plugin.mutate(async () => {
        // The template and tone chosen for the import become the new map's defaults, not per-topic fields.
        const chosenTemplate = request.detailTemplateId;
        const chosenTone = request.toneId;
        if (chosenTemplate || chosenTone)
          await this.plugin.repo.updateMap(result.mapPath, map => {
            if (chosenTemplate) map.detailTemplateId = chosenTemplate;
            if (chosenTone) map.toneId = chosenTone;
          });
        // Notes and Map.md were written directly; derive their Reference Links (map, parent, children) like any map change.
        await this.plugin.rebuildDerivedData();
        await this.openMapInMutation(result.mapPath);
        if (!this.closed && this.path === result.mapPath) this.fit();
      });
    } catch {
      opened = false; // mutate() has already shown the Notice.
    }
    if (result.failure) new Notice(t("ui.outline_import_partial", result.created, result.total, result.failure));
    if (result.failure || !opened || !request.shallowResearch || result.nodes.length < 2) return;
    const root = result.nodes.find(node => node.parentId === null);
    if (!root) return;
    const children = result.nodes.filter(node => node.parentId !== null);
    // The import window closes once the topics exist: the research runs in the background (Stop is on the batch badge)
    // and an error becomes a Notice instead of keeping the window waiting.
    void this.plugin
      .confirmAiUsage(model, () =>
        this.startShallowResearch(root, children, {
          ...aiModeOptions(request.aiMode ?? "quick", "subtopic"),
          referenceGroups: []
        })
      )
      .catch(error => new Notice(errorMessage(error)));
  }
  /** Adds the outline to the open map, as a new top-level tree or under the selected topic; existing nodes stay put. */
  private async importOutlineIntoMap(
    request: OutlineImportRequest,
    placement: Exclude<OutlinePlacement, { kind: "new" }>
  ): Promise<void> {
    const settings = this.plugin.settings;
    const repo = this.plugin.repo;
    // Checked against the map as it is when the work runs; a rejection keeps the import window open.
    const target = (): { map: MapDocument; path: string; parent: MapNode | null } => {
      const where = this.outlineImportTarget();
      if (!this.map || where.map !== "editable")
        throw new Error(
          where.map === "aim" ? t("ui.outline_import_placement_aim") : t("ui.outline_import_placement_no_map")
        );
      if (placement.kind === "tree") return { map: this.map, path: this.path, parent: null };
      const parent = this.map.nodes.find(node => node.id === placement.parentId);
      if (!parent) throw new Error(t("ui.outline_import_selected_missing"));
      return { map: this.map, path: this.path, parent };
    };
    target();
    // Filled inside the queued work (an object, so the compiler does not narrow it away).
    const state: {
      rejection?: Error;
      result?: Awaited<ReturnType<typeof addOutlineToMap>>;
      saveFailed?: boolean;
    } = {};
    const currentModel = this.plugin.currentModelChoice().model;
    let model = currentModel;
    let written = true;
    try {
      await this.plugin.mutate(async () => {
        let current;
        try {
          current = target();
        } catch (error) {
          state.rejection = error instanceof Error ? error : new Error(String(error));
          return;
        }
        const { map, path, parent } = current;
        // A model chosen for the shallow research becomes the new topics' model; otherwise they inherit like new children.
        const baseModel = parent
          ? inheritModel((await repo.readNote(parent.path, map)).model, currentModel)
          : currentModel;
        model = (request.shallowResearch && request.model) || baseModel;
        // A template chosen here is recorded on each new topic: an import never changes this map's default.
        const template = this.mapDetailTemplate(settings.language, request.detailTemplateId);
        const result = await addOutlineToMap(
          repo,
          map,
          path,
          model,
          request.nodes,
          request.source,
          parent?.id ?? null,
          template,
          request.detailTemplateId,
          undefined,
          Boolean(request.shallowResearch && request.model && request.model !== baseModel),
          request.toneId
        );
        state.result = result;
        const created = result.created;
        if (!created.length && !result.failure) return;
        for (const node of created) {
          try {
            this.notes.set(node.id, await repo.readNote(node.path, { ...map, nodes: [...map.nodes, ...created] }));
          } catch {
            // The note exists; the view reloads it on the next hydrate.
          }
        }
        // The notes were made outside the transaction (D-2026-10-319, D-2026-10-320): any failure puts the vault back as it was.
        // A note the saved Map.md still holds is kept (the map must not point at a missing file); the rest go to the trash.
        const rollBack = async (error: unknown): Promise<void> => {
          const cause = error instanceof Error ? error : new Error(String(error));
          let referenced: Set<string> | null = null;
          if (created.length) {
            try {
              referenced = new Set((await repo.readMap(path)).nodes.map(node => node.id));
            } catch {
              // Map.md cannot be read: nothing is trashed.
            }
          }
          const kept: string[] = [];
          for (const node of [...created].reverse()) {
            const file = repo.app.vault.getAbstractFileByPath(node.path);
            if (!referenced || referenced.has(node.id)) {
              kept.unshift(node.path);
              continue;
            }
            if (!(file instanceof TFile)) {
              this.notes.delete(node.id);
              continue;
            }
            try {
              await repo.app.fileManager.trashFile(file);
              this.notes.delete(node.id);
            } catch {
              kept.unshift(node.path);
            }
          }
          this.render();
          if (!kept.length) {
            state.rejection = cause;
            return;
          }
          // Notes remain: the window closes so a retry cannot create a second set.
          state.saveFailed = true;
          new Notice(t("ui.outline_import_map_save_failed", `${errorMessage(cause)} (${kept.join(", ")})`));
        };
        if (result.failure) return rollBack(new Error(result.failure));
        const top = created[0];
        const ids = new Set(created.map(node => node.id));
        // Created notes, the Map.md edit and the derived data are one transaction; undo parks the notes in Unassigned.
        const tx = this.beginMapTransaction();
        for (const node of created) tx.create(node.path, repo.topicFolder(path, "Unassigned"), map.id);
        const viewport = clone(map.viewport);
        const opened = this.map;
        let after!: MapDocument;
        try {
          const entry = await tx
            .editMap(path, next => {
              // Map.md on disk may hold an older viewport: the edit starts from the one on screen.
              next.viewport = clone(viewport);
              next.nodes.push(...created);
              // The map may have been swapped for the file version by the conflict window: without the parent there,
              // the outline becomes a new tree rather than a node pointing at a missing parent.
              const owner = parent ? next.nodes.find(node => node.id === parent.id && !ids.has(node.id)) : undefined;
              const outlineTop = next.nodes.find(node => node.id === top.id)!;
              if (owner) {
                owner.collapsed = false;
                next.nodes = arrangeNewBranch(next.nodes, owner.id, ids, this.cardHeightOf, undefined, layoutOf(next));
              } else {
                outlineTop.parentId = null;
                next.nodes = arrangeNewTree(next.nodes, top.id, ids, this.cardHeightOf, layoutOf(next));
              }
              after = clone(next);
            })
            .commit();
          this.history.push(entry);
          // A conflict window replaces this.map: the viewport on screen wins over the one in the file version.
          if (this.map && (this.map !== opened || JSON.stringify(after.viewport) !== JSON.stringify(viewport)))
            this.map.viewport = clone(after.viewport);
        } catch (error) {
          await rollBack(error);
          return;
        }
        const placed = this.map?.nodes.find(node => node.id === top.id);
        if (placed) {
          this.selected = placed.id;
          this.render();
          this.focusNode(placed);
        }
      });
    } catch {
      written = false; // mutate() has already shown the Notice.
    }
    if (state.rejection) throw state.rejection;
    const outcome = state.result;
    if (!outcome) return;
    if (state.saveFailed || !written || !request.shallowResearch || !outcome.created.length) return;
    // An outline with several top headings, or one without a root of its own (quick explore drops the topic's root),
    // is researched under the parent.
    const owner = placement.kind === "under" ? placement.parentId : null;
    const several =
      owner !== null && (!!request.researchEveryTopic || request.nodes.filter(node => node.parent === null).length > 1);
    const top = this.map?.nodes.find(node => node.id === (several ? owner : outcome.created[0].id));
    if (!top) return;
    // Every other created topic descends from the outline's top topic; the top topic and an "under" parent are not researched.
    const ids = new Set((several ? outcome.created : outcome.created.slice(1)).map(node => node.id));
    const children = (this.map?.nodes ?? []).filter(node => ids.has(node.id));
    if (!children.length) return;
    // The import window closes once the topics exist; the research runs in the background (Stop is on the batch badge).
    void this.plugin
      .confirmAiUsage(model, () =>
        this.startShallowResearch(top, children, {
          ...aiModeOptions(request.aiMode ?? "quick", "subtopic"),
          referenceGroups: [],
          ...request.researchOptions,
          ...(request.detailTemplateId ? { detailTemplateId: request.detailTemplateId } : {}),
          ...(request.toneId ? { toneId: request.toneId } : {})
        })
      )
      .catch(error => new Notice(errorMessage(error)));
  }
  private openNewMindMapModal(): void {
    new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title =>
      this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))
    ).open();
  }
  async planAimQuestion(
    parentNodeId: string,
    requestId: string,
    parentBranchId: string | null = null,
    signal?: AbortSignal
  ): Promise<PlannerQuestionResult> {
    if (this.closed || !this.map || !this.path || this.builtIn)
      throw new Error("Open a saved AIM map before planning its next question.");
    const mapPath = this.path,
      epoch = this.aimViewEpoch;
    const parent = this.notes.get(parentNodeId);
    if (!parent) throw new Error("The selected Planner question parent is unavailable.");
    const planned: PlannerQuestionResult = await this.aimManual.planNextQuestion(
      mapPath,
      parentNodeId,
      parent.model,
      parent.reasoning,
      requestId,
      parentBranchId,
      signal
    );
    const isCurrent = () => this.aimViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    if (isCurrent()) {
      const latest = await this.plugin.repo.readMap(mapPath);
      if (isCurrent()) {
        this.map = latest;
        await this.hydrate(isCurrent);
        if (isCurrent()) {
          this.render();
          this.syncOutline();
        }
      }
    }
    return planned;
  }
  async submitAimAnswer(
    questionNodeId: string,
    input: { requestId: string; selections: string[]; freeText: string },
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    if (this.closed || !this.map || !this.path || this.builtIn)
      throw new Error("Open a saved AIM map before submitting an answer.");
    const mapPath = this.path,
      epoch = this.aimViewEpoch;
    const isCurrent = () => this.aimViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    const question = this.notes.get(questionNodeId);
    if (!question) throw new Error("The selected Planner question is unavailable.");
    signal?.throwIfAborted();
    let recoveredBranches = 0;
    await this.plugin.mutate(async () => {
      recoveredBranches = await this.aimRuns.recoverAnswerBranches(mapPath);
    });
    if (recoveredBranches) {
      if (!isCurrent()) return { status: "stale", branchId: "" };
      this.map = await this.plugin.repo.readMap(mapPath);
      await this.hydrate(isCurrent);
      if (!isCurrent()) return { status: "stale", branchId: "" };
      this.render();
      this.syncOutline();
    }
    try {
      const outcome = await this.aimManual.answerAndResearch(
        mapPath,
        questionNodeId,
        input,
        question.model,
        question.reasoning,
        signal,
        async activeQuestionNodeId => {
          if (!isCurrent()) return;
          this.aimActiveQuestionNodeId = activeQuestionNodeId;
          this.map = await this.plugin.repo.readMap(mapPath);
          await this.hydrate(isCurrent);
          if (isCurrent()) this.render();
        }
      );
      if (isCurrent()) {
        const latest = await this.plugin.repo.readMap(mapPath);
        if (isCurrent()) {
          this.map = latest;
          await this.hydrate(isCurrent);
          if (isCurrent()) {
            this.render();
            this.syncOutline();
          }
        }
      }
      return outcome;
    } catch (error) {
      if (isCurrent()) {
        const latest = await this.plugin.repo.readMap(mapPath);
        if (isCurrent()) {
          this.map = latest;
          await this.hydrate(isCurrent);
          if (isCurrent()) {
            this.render();
            this.syncOutline();
          }
        }
      }
      throw error;
    }
  }
  private renderAimFailure(card: HTMLElement, branch: import("../../map-model").AimBranchRecord): void {
    const runs = this.map?.aim?.runs.filter(run => run.branchId === branch.id) ?? [];
    const latest = runs.at(-1),
      attempt = latest?.attempts.find(item => item.id === latest.currentAttemptId);
    if (attempt?.status !== "failed" && !branch.researchPlanError) return;
    const box = card.createDiv({ cls: "vam-aim-failure" });
    box.createEl("p", {
      text: t("ui.aim_failure_reason", attempt?.stopReason || branch.researchPlanError || t("ui.expansion_failed"))
    });
    const phase =
      attempt?.phase ?? branch.deliveryRecovery?.phase ?? (branch.researchPlanError ? "research-plan" : undefined);
    const labels: Record<string, string> = {
      "subtopic-research": t("ui.aim_stage_subtopic"),
      "report-review": t("ui.aim_stage_review"),
      "research-plan": t("ui.aim_stage_plan"),
      "delivery-outline": t("ui.aim_stage_delivery_outline"),
      "delivery-research": t("ui.aim_stage_delivery_research"),
      "delivery-writing": t("ui.aim_stage_delivery_writing"),
      "delivery-acceptance": t("ui.aim_stage_delivery_acceptance")
    };
    if (phase && labels[phase]) box.createEl("p", { text: t("ui.aim_failure_stage", labels[phase]) });
    const reason = attempt?.stopReason ?? branch.researchPlanError ?? "";
    const timedOut = aimTimedOut(reason);
    box.createEl("p", { text: t(aimRepairHint(reason)) });
    if (timedOut)
      this.button(
        box,
        t("ui.aim_repair_timeout"),
        () => {
          const terminal = [...branch.results].reverse().find(result => result.kind !== "research");
          if (terminal) void this.continueAimResearch(branch.questionNodeId, terminal.runId, 600_000);
          else void this.retryAimSubtopics(branch.id, 600_000);
        },
        this.aimBusy
      ).addClass("mod-cta");
  }

  private async retryAimSubtopics(branchId: string, timeoutMs?: number): Promise<void> {
    const branch = this.map?.aim?.branches.find(item => item.id === branchId),
      question = branch && this.map?.nodes.find(item => item.id === branch.questionNodeId);
    const note = question && this.notes.get(question.id);
    if (this.closed || !this.path || !branch || !question || !note || this.aimBusy) return;
    const branchRuns = (this.map?.aim?.runs ?? []).filter(item => item.branchId === branch.id);
    if (
      branchRuns.some(run => {
        const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      })
    )
      return;
    const terminal = branch.results.some(result => result.kind !== "research");
    if (terminal) return;
    const epoch = this.aimViewEpoch,
      mapPath = this.path,
      controller = new AbortController();
    this.aimBusy = true;
    this.aimController = controller;
    this.aimActiveQuestionNodeId = question.id;
    this.aimActivityKind = "research";
    this.render();
    try {
      if (timeoutMs) await this.plugin.mutate(() => this.aimRuns.configureRetryTimeout(mapPath, branch.id, timeoutMs));
      const result = branch.researchPlan
        ? await this.aimManual.resumeAnswerResearch(mapPath, branch.id, note.model, note.reasoning, controller.signal)
        : await this.aimManual.retryAnswerResearch(mapPath, branch.id, note.model, note.reasoning, controller.signal);
      this.noticeDocumentReadyElsewhere(result.status, epoch, mapPath);
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      const latest = await this.plugin.repo.readMap(mapPath);
      if (this.aimViewIsCurrent(epoch, mapPath)) {
        this.map = latest;
        await this.hydrate(() => this.aimViewIsCurrent(epoch, mapPath));
        this.render();
        this.syncOutline();
      }
      if (result.status === "waiting-user") {
        const question = this.map?.nodes.find(item => item.id === result.questionNodeId);
        if (question) {
          this.selected = question.id;
          this.render();
          this.focusNode(question);
        }
        new Notice(t("ui.aim_waiting_user"));
      } else if (result.status === "partial") new Notice(t("ui.aim_research_partial"));
      else if (result.status === "completed") showDocumentReady();
      else if (result.status === "in-progress") new Notice(t("ui.aim_research_already_running"));
    } catch (error) {
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
      const latest = await this.plugin.repo.readMap(mapPath);
      if (this.aimViewIsCurrent(epoch, mapPath)) {
        this.map = latest;
        await this.hydrate(() => this.aimViewIsCurrent(epoch, mapPath));
        this.render();
        this.syncOutline();
      }
    } finally {
      if (this.aimController === controller) {
        this.aimBusy = false;
        this.aimController = null;
        this.aimActiveQuestionNodeId = null;
        this.aimActivityKind = null;
        if (this.aimViewIsCurrent(epoch, mapPath)) this.render();
      }
    }
  }
  async reviewAimFailedReport(
    runId: string,
    diagnosticNotePath: string,
    signal?: AbortSignal
  ): Promise<ManualResearchResult> {
    if (this.closed || !this.map || !this.path || this.builtIn)
      throw new Error("Open the saved AIM map before reviewing a failed report.");
    const mapPath = this.path,
      epoch = this.aimViewEpoch;
    const outcome = await this.aimManual.reviewFailedAttemptReport(mapPath, runId, diagnosticNotePath, signal);
    const isCurrent = () => this.aimViewIsCurrent(epoch, mapPath) && !signal?.aborted;
    if (isCurrent()) {
      const latest = await this.plugin.repo.readMap(mapPath);
      if (isCurrent()) {
        this.map = latest;
        await this.hydrate(isCurrent);
        if (isCurrent()) {
          this.render();
          this.syncOutline();
        }
      }
    }
    return outcome;
  }
  private async correctAimAssumption(nodeId: string, assumption: string, correction: string): Promise<void> {
    await this.runAimFollowup(nodeId, (mapPath, model, reasoning, signal) =>
      this.aimManual.correctAssumption(mapPath, nodeId, assumption, correction, model, reasoning, signal)
    );
  }
  /** Change direction: during a run it stops that run first (finished research stays), then follows the new focus. */
  private async steerAim(from: { nodeId?: string | null; branchId?: string | null }, direction: string): Promise<void> {
    if (this.aimBusy) {
      this.aimController?.abort();
      for (let waited = 0; this.aimBusy && waited < 30_000; waited += 100)
        await new Promise(resolve => window.setTimeout(resolve, 100));
      if (this.aimBusy) {
        new Notice(t("ui.aim_research_already_running"));
        return;
      }
    }
    await this.runAimFollowup(from.nodeId ?? null, (mapPath, model, reasoning, signal) =>
      this.aimManual.steer(mapPath, from, direction, model, reasoning, signal)
    );
  }
  /** Runs one AIM follow-up from a node (or the topic) with the usual busy state, notices and refresh. */
  private async runAimFollowup(
    nodeId: string | null,
    run: (mapPath: string, model: string, reasoning: unknown, signal: AbortSignal) => Promise<ManualResearchResult>
  ): Promise<void> {
    const topic = this.map?.nodes.find(item => item.aimKind === "topic");
    const node = this.map?.nodes.find(item => item.id === nodeId) ?? topic;
    const note = (node && this.notes.get(node.id)) ?? (topic && this.notes.get(topic.id));
    if (this.closed || !node || !note || !this.path || !this.map?.aim) return;
    if (this.aimBusy) {
      new Notice(t("ui.aim_research_already_running"));
      return;
    }
    const epoch = this.aimViewEpoch,
      mapPath = this.path,
      controller = new AbortController();
    this.aimBusy = true;
    this.aimController = controller;
    this.aimActiveQuestionNodeId = node.id;
    this.aimActivityKind = "research";
    this.render();
    try {
      const outcome = await run(mapPath, note.model, note.reasoning, controller.signal);
      this.noticeDocumentReadyElsewhere(outcome.status, epoch, mapPath);
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      this.map = await this.plugin.repo.readMap(mapPath);
      await this.hydrate(() => this.aimViewIsCurrent(epoch, mapPath));
      if (outcome.status === "completed") showDocumentReady();
      else if (outcome.status === "partial") new Notice(t("ui.aim_research_partial"));
      else if (outcome.status === "waiting-user") new Notice(t("ui.aim_waiting_user"));
    } catch (error) {
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.aimController === controller) {
        this.aimBusy = false;
        this.aimController = null;
        this.aimActiveQuestionNodeId = null;
        this.aimActivityKind = null;
        if (this.aimViewIsCurrent(epoch, mapPath)) {
          this.render();
          this.syncOutline();
        }
      }
    }
  }
  private async planAimFromSelection(nodeId = this.selected): Promise<void> {
    const node = this.map?.nodes.find(item => item.id === nodeId);
    if (this.closed || !node || !this.path || !this.map?.aim || this.aimBusy) return;
    const epoch = this.aimViewEpoch,
      mapPath = this.path,
      controller = new AbortController();
    const contentLanguage = resolveAimContentLanguage(this.map, this.plugin.settings.language);
    const parentBranchId =
      this.map.aim.branches.find(branch => branch.results.some(result => result.nodeId === node.id))?.id ?? null;
    this.aimBusy = true;
    this.aimController = controller;
    this.aimActiveQuestionNodeId = node.id;
    this.aimActivityKind = "planning";
    this.render();
    try {
      const rootNote = this.notes.get(node.id);
      if (node.aimKind === "topic" && rootNote && !rootNote.detail.includes("<!-- aim-intake-complete -->")) {
        this.aimActivityKind = "clarifying";
        this.render();
        const questions = await this.aimManual.prepareClarification(rootNote, contentLanguage, controller.signal);
        if (!this.aimViewIsCurrent(epoch, mapPath) || controller.signal.aborted) return;
        if (questions.length) {
          new AimClarificationModal(
            this.app,
            questions,
            async answers => {
              if (!this.aimViewIsCurrent(epoch, mapPath)) throw new Error("Reopen the original AIM map to continue.");
              await this.plugin.mutate(async () => {
                const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
                if (!latest.detail.includes("<!-- aim-intake-complete -->")) {
                  await this.plugin.repo.updateNote(
                    node.path,
                    {
                      detail:
                        latest.detail +
                        "\n\n<!-- aim-intake-complete -->\n## " +
                        translateNote(contentLanguage, "note.aim_initial_clarification") +
                        "\n\n" +
                        answers
                    },
                    { contentLanguage: noteLanguageOf(contentLanguage) }
                  );
                }
              });
              await this.hydrate();
              void this.planAimFromSelection(node.id);
            },
            this.plugin.settings.language,
            contentLanguage
          ).open();
          return;
        }
        await this.plugin.mutate(async () => {
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          await this.plugin.repo.updateNote(
            node.path,
            { detail: latest.detail + "\n\n<!-- aim-intake-complete -->" },
            { contentLanguage: noteLanguageOf(contentLanguage) }
          );
        });
        await this.hydrate();
      }
      this.aimActivityKind = "planning";
      this.render();
      const result = await this.planAimQuestion(node.id, randomUUID(), parentBranchId, controller.signal);
      this.noticeDocumentReadyElsewhere(
        result.status === "question" ? undefined : result.outcome?.status,
        epoch,
        mapPath
      );
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (result.status === "question") {
        this.selected = result.node.id;
        this.render();
        this.focusNode(result.node);
        new Notice(t("ui.aim_question_ready"));
      } else if (result.outcome) {
        const outcome = result.outcome;
        if (outcome.status === "partial") new Notice(t("ui.aim_research_partial"));
        else if (outcome.status === "waiting-user") {
          const question = this.map?.nodes.find(item => item.id === outcome.questionNodeId);
          if (question) {
            this.selected = question.id;
            this.render();
            this.focusNode(question);
          }
          new Notice(t("ui.aim_waiting_user"));
        } else if (outcome.status === "completed") showDocumentReady();
        else if (outcome.status === "in-progress") new Notice(t("ui.aim_research_already_running"));
        else new Notice(t("ui.aim_research_result_stale"));
      } else new Notice(t("ui.aim_no_question_needed"));
    } catch (error) {
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.aimController === controller) {
        this.aimBusy = false;
        this.aimController = null;
        this.aimActiveQuestionNodeId = null;
        this.aimActivityKind = null;
        if (this.aimViewIsCurrent(epoch, mapPath)) this.render();
      }
    }
  }
  private async retryAimFromSavedReport(questionNodeId: string): Promise<void> {
    const target = this.aimFailedReports.get(questionNodeId),
      mapPath = this.path,
      epoch = this.aimViewEpoch;
    if (this.closed || !target || !mapPath || !this.map?.aim || this.aimBusy || this.builtIn) return;
    const run = this.map.aim.runs.find(item => item.id === target.runId);
    const currentAttempt = run?.attempts.find(item => item.id === run.currentAttemptId);
    const branch = run && this.map.aim.branches.find(item => item.id === run.branchId);
    if (!run || currentAttempt?.status !== "failed" || branch?.questionNodeId !== questionNodeId) {
      this.aimFailedReports.delete(questionNodeId);
      this.render();
      return;
    }
    const controller = new AbortController();
    this.aimBusy = true;
    this.aimController = controller;
    this.aimActiveQuestionNodeId = questionNodeId;
    this.aimActivityKind = "research";
    this.render();
    try {
      const result = await this.reviewAimFailedReport(target.runId, target.diagnosticNotePath, controller.signal);
      this.noticeDocumentReadyElsewhere(result.status, epoch, mapPath);
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (result.status === "waiting-user") {
        const question = this.map?.nodes.find(item => item.id === result.questionNodeId);
        if (question) {
          this.selected = question.id;
          this.render();
          this.focusNode(question);
        }
        new Notice(t("ui.aim_waiting_user"));
      } else if (result.status === "partial") new Notice(t("ui.aim_research_partial"));
      else if (result.status === "completed") showDocumentReady();
      else if (result.status === "in-progress") new Notice(t("ui.aim_research_already_running"));
      else new Notice(t("ui.aim_research_result_stale"));
    } catch (error) {
      if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
      if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      else new Notice(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.aimController === controller) {
        this.aimBusy = false;
        this.aimController = null;
        this.aimActiveQuestionNodeId = null;
        this.aimActivityKind = null;
        if (this.aimViewIsCurrent(epoch, mapPath)) this.render();
      }
    }
  }
  private async continueAimResearch(questionNodeId: string, runId: string, timeoutMs?: number): Promise<void> {
    const mapPath = this.path,
      epoch = this.aimViewEpoch;
    if (this.closed || !mapPath || !this.map?.aim || this.aimBusy || this.builtIn) return;
    const run = this.map.aim.runs.find(item => item.id === runId);
    const branch = run && this.map.aim.branches.find(item => item.id === run.branchId);
    if (!run || branch?.questionNodeId !== questionNodeId) return;
    const controller = new AbortController();
    this.aimBusy = true;
    this.aimController = controller;
    this.aimActiveQuestionNodeId = questionNodeId;
    this.aimActivityKind = "research";
    this.render();
    const isCurrent = () => this.aimViewIsCurrent(epoch, mapPath) && this.aimController === controller;
    try {
      if (timeoutMs && branch)
        await this.plugin.mutate(() => this.aimRuns.configureRetryTimeout(mapPath, branch.id, timeoutMs));
      const result = await this.aimManual.continuePartial(
        mapPath,
        runId,
        this.notes.get(questionNodeId)?.model,
        this.notes.get(questionNodeId)?.reasoning,
        controller.signal
      );
      this.noticeDocumentReadyElsewhere(result.status, epoch, mapPath);
      if (!isCurrent()) return;
      // Select the new question so the toolbar answers it, not the previously selected one; the finally block re-renders after reloading the map.
      if (result.status === "waiting-user") {
        this.selected = result.questionNodeId;
        new Notice(t("ui.aim_waiting_user"));
      } else if (result.status === "partial") new Notice(t("ui.aim_research_partial"));
      else if (result.status === "completed") showDocumentReady();
      else if (result.status === "in-progress") new Notice(t("ui.aim_research_already_running"));
    } catch (error) {
      if (!isCurrent()) return;
      new Notice(
        controller.signal.aborted
          ? t("ui.research_stopped_existing_content_was_preserved")
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      if (this.aimController === controller) {
        try {
          if (this.aimViewIsCurrent(epoch, mapPath)) {
            const latest = await this.plugin.repo.readMap(mapPath);
            if (isCurrent()) {
              this.map = latest;
              await this.hydrate(isCurrent);
            }
          }
        } catch (error) {
          if (isCurrent()) new Notice(error instanceof Error ? error.message : String(error));
        } finally {
          if (this.aimController === controller) {
            this.aimBusy = false;
            this.aimController = null;
            this.aimActiveQuestionNodeId = null;
            this.aimActivityKind = null;
            if (this.aimViewIsCurrent(epoch, mapPath)) {
              this.render();
              this.syncOutline();
            }
          }
        }
      }
    }
  }
  private openAimAnswer(node: MapNode): void {
    const contract = node.aimQuestion,
      note = this.notes.get(node.id);
    if (this.closed || !contract || !note || this.aimBusy) return;
    const epoch = this.aimViewEpoch,
      mapPath = this.path,
      requestId = contract.requestId;
    if (mapPath && (this.map?.aim?.branches.filter(branch => branch.questionNodeId === node.id).length ?? 0) > 1) {
      void this.plugin
        .mutate(async () => {
          const repaired = await this.aimRuns.recoverAnswerBranches(mapPath);
          if (!repaired || !this.aimViewIsCurrent(epoch, mapPath)) return;
          this.map = await this.plugin.repo.readMap(mapPath);
          await this.hydrate(() => this.aimViewIsCurrent(epoch, mapPath));
          if (!this.aimViewIsCurrent(epoch, mapPath)) return;
          this.render();
          const current = this.map?.nodes.find(item => item.id === node.id);
          if (current) this.openAimAnswer(current);
        })
        .catch(error => {
          if (this.aimViewIsCurrent(epoch, mapPath)) new Notice(error instanceof Error ? error.message : String(error));
        });
      return;
    }
    new AimAnswerModal(
      this.app,
      note.summary,
      contract.options,
      async input => {
        const currentQuestion = this.map?.nodes.find(item => item.id === node.id);
        if (
          !this.aimViewIsCurrent(epoch, mapPath) ||
          currentQuestion?.aimQuestion?.requestId !== requestId ||
          this.aimBusy
        )
          return;
        const controller = new AbortController();
        this.aimBusy = true;
        this.aimController = controller;
        this.aimActiveQuestionNodeId = node.id;
        this.aimActivityKind = "research";
        this.render();
        try {
          const result = await this.submitAimAnswer(node.id, input, controller.signal);
          if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) return;
          this.aimAnswerRequestIds.delete(node.id);
          if (result.status === "waiting-user") {
            const question = this.map?.nodes.find(item => item.id === result.questionNodeId);
            if (question) {
              this.selected = question.id;
              this.render();
              this.focusNode(question);
            }
            new Notice(t("ui.aim_waiting_user"));
          } else if (result.status === "partial") new Notice(t("ui.aim_research_partial"));
          else if (result.status === "completed") showDocumentReady();
          else if (result.status === "in-progress") new Notice(t("ui.aim_research_already_running"));
          else new Notice(t("ui.aim_research_result_stale"));
        } catch (error) {
          if (!this.aimViewIsCurrent(epoch, mapPath) || this.aimController !== controller) throw error;
          this.aimAnswerRequestIds.set(node.id, input.requestId);
          if (controller.signal.aborted) new Notice(t("ui.research_stopped_existing_content_was_preserved"));
          else new Notice(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          if (this.aimController === controller) {
            this.aimBusy = false;
            this.aimController = null;
            this.aimActiveQuestionNodeId = null;
            this.aimActivityKind = null;
            if (this.aimViewIsCurrent(epoch, mapPath)) this.render();
          }
        }
      },
      this.aimAnswerRequestIds.get(node.id) ?? randomUUID()
    ).open();
  }
  async openBuiltInSample(forceTour = false): Promise<void> {
    const viewEpoch = this.aimViewEpoch,
      openEpoch = ++this.mapOpenEpoch;
    const isCurrent = () => !this.closed && this.aimViewEpoch === viewEpoch && this.mapOpenEpoch === openEpoch;
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persistViewport();
    }
    if (!isCurrent()) return;
    // Leaving the map for the sample frees the pre-started CLI, like opening another map does.
    if (this.relevancePanelOpen) this.plugin.releaseWarmClaude?.();
    this.abortRelevanceGrade();
    const sample = builtInSample(noteLanguageOf(this.plugin.settings.language));
    if (!this.builtIn) this.plugin.closeStaleDetails();
    this.closeMapSearch(false);
    this.exitPresentation(false);
    this.builtIn = true;
    this.path = "";
    this.map = sample.map;
    this.notes = sample.notes;
    this.integrationMode = false;
    this.selected = null;
    this.multiSelected.clear();
    this.history.clear();
    this.showSampleTour = forceTour || this.plugin.settings.sampleTourVersionSeen < SAMPLE_TOUR_VERSION;
    this.sampleTourStep = 0;
    this.selected = this.showSampleTour ? "explore" : null;
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  changed(file: TFile): void {
    if (file.path !== this.path && !this.map?.nodes.some(node => node.path === file.path)) return;
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      if (this.closed) return;
      if (this.dragging) {
        this.changed(file);
        return;
      }
      // The chat field is a text field too, but it is where the user waits for the map to change: only an IME
      // composition in it holds the repaint back.
      if (this.typingInField()) {
        this.changed(file);
        return;
      }
      this.enqueue(async () => {
        if (file.path === this.path) {
          this.map = await this.plugin.repo.readMap(this.path);
          this.history.clear();
          await this.plugin.rebuildDerivedData();
        }
        await this.hydrate();
        this.render();
      });
    }, 400);
  }
  /** Whether this view is running or saving AIM work for the map at `path`. */
  hasActiveAimWork(path: string): boolean {
    return (
      this.path === path &&
      !!this.map?.aim &&
      (this.aimBusy ||
        this.map.aim.runs.some(run =>
          run.attempts.some(attempt => attempt.status === "running" || attempt.status === "saving")
        ))
    );
  }
  /** After "Organize workspace folders" moved maps: follow the open map to its new path (the next synchronize reloads it). */
  relocate(moved: Map<string, string>): void {
    const next = moved.get(this.path);
    if (!next) return;
    this.path = next;
    this.history.clear();
  }
  async renamed(file: TFile, oldPath: string): Promise<void> {
    if (this.path === oldPath) this.path = file.path;
    if (this.map) {
      rebaseMapNotePaths(this.map, moveNotePath(oldPath, file.path));
      this.history.clear();
      await this.hydrate();
      this.render();
    }
  }
  deleted(file: TFile): void {
    if (file.path === this.path) {
      this.map = null;
      this.path = "";
      if (this.deletedMap?.path !== file.path) this.history.clear();
      this.render();
    } else this.changed(file);
  }
  private iconButton(
    parent: HTMLElement,
    icon: string,
    label: string,
    action: (event: MouseEvent) => void
  ): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon vam-icon-button" });
    if (this.renderingCard) button.tabIndex = -1;
    button.setAttr("aria-label", label);
    button.dataset.icon = icon;
    setIcon(button, icon);
    button.addEventListener("click", event => {
      event.stopPropagation();
      action(event);
    });
    return button;
  }
  private openMapSwitcher(): void {
    this.enqueue(async () => {
      const topics = await this.plugin.repo.topics();
      new ChoiceModal(this.app, t("ui.switch_mind_map"), t("ui.choose_a_research_topic_to_open"), [
        {
          label: t("ui.sample_taiwan_travel_plan"),
          description: t("ui.official_read_only_sample"),
          action: () => this.enqueue(() => this.openBuiltInSample())
        },
        ...topics.map(topic => ({
          label: topic.title,
          description: t("ui.my_editable_mind_map"),
          action: () => this.enqueue(() => this.openMapInMutation(topic.mapPath))
        }))
      ]).open();
    });
  }
  /** The three ways to start a map sit together, so none reads as the only or the hidden option. */
  private openNewMapMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle(t("ui.new_mind_map"))
        .setIcon("file-plus")
        .onClick(() =>
          new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title =>
            this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))
          ).open()
        )
    );
    menu.addItem(item =>
      item
        .setTitle(t("ui.aim_create_map"))
        .setIcon("route")
        .onClick(() => this.openAimStart())
    );
    menu.showAtMouseEvent(event);
  }
  /** Research coverage is the map's headline fact: how much of the frontier already has a conclusion. */
  private onAimProgress(event: AimProgressEvent): void {
    if (this.closed || event.mapPath !== this.path) return;
    this.ensureAimBranchModel(event.branchId);
    let structural = false;
    if (event.kind === "plan") {
      this.aimProgress = {
        branchId: event.branchId,
        stage: "research",
        startedAt: this.aimProgress?.branchId === event.branchId ? this.aimProgress.startedAt : Date.now(),
        targets: new Map(
          event.targets.map(target => [target.id, { title: target.title, state: "queued", searches: 0 }])
        )
      };
      structural = true;
    } else if (!this.aimProgress || this.aimProgress.branchId !== event.branchId) {
      if (event.kind !== "stage") return;
      this.aimProgress = { branchId: event.branchId, stage: event.stage, startedAt: Date.now(), targets: new Map() };
      structural = true;
    } else if (event.kind === "subtopic") {
      const target = this.aimProgress.targets.get(event.subtopicId);
      if (!target) return;
      if (target.state !== event.state) {
        structural = true;
        target.state = event.state;
        if (event.state === "searching") target.startedAt = Date.now();
      }
      if (event.searches !== undefined) target.searches = event.searches;
      this.aimProgress.stage = "research";
    } else {
      this.aimProgress.stage = event.stage;
    }
    if (this.aimProgressTimer === null) this.aimProgressTimer = window.setInterval(() => this.paintAimProgress(), 1000);
    if (structural) this.scheduleAimProgressRender();
  }
  /** True while the user is typing in a text field of the view. The chat field counts only during IME composition (as in changed()). */
  private typingInField(): boolean {
    const active = this.contentEl.ownerDocument?.activeElement ?? null;
    return this.chat?.isInput(active)
      ? this.chat.isComposing
      : this.contentEl.contains(active) && !!active?.matches("input, textarea, select");
  }
  private scheduleAimProgressRender(): void {
    if (this.aimProgressRenderTimer !== null) return;
    this.aimProgressRenderTimer = window.setTimeout(() => {
      this.aimProgressRenderTimer = null;
      if (this.closed) return;
      // Like changed(): never interrupt a drag or an open input; try again shortly instead.
      const typing = this.typingInField();
      if (this.dragging || typing) this.scheduleAimProgressRender();
      else this.renderPreservingFocus();
    }, 300);
  }
  private stopAimProgress(): void {
    this.aimProgress = null;
    this.aimBranchModels.clear();
    this.aimProgressEls.clear();
    if (this.aimProgressTimer !== null) window.clearInterval(this.aimProgressTimer);
    if (this.aimProgressRenderTimer !== null) window.clearTimeout(this.aimProgressRenderTimer);
    this.aimProgressTimer = this.aimProgressRenderTimer = null;
  }
  private aimTargetText(target: AimTargetProgress): string {
    if (target.state === "queued") return t("ui.aim_progress_queued");
    if (target.state === "done") return t("ui.aim_progress_done");
    if (target.state === "skipped") return t("ui.aim_progress_skipped");
    return t(
      "ui.aim_progress_searching_0_1",
      target.searches,
      Math.round((Date.now() - (target.startedAt ?? Date.now())) / 1000)
    );
  }
  /** The branch root topic's resolved model, read once per branch (the cache answers every later event and tick). */
  private ensureAimBranchModel(branchId: string): void {
    if (this.aimBranchModels.has(branchId) || this.aimBranchModelPending.has(branchId)) return;
    const branches = this.map?.aim?.branches ?? [];
    let root = branches.find(item => item.id === branchId);
    for (let depth = 0; root?.parentBranchId && depth < branches.length; depth++)
      root = branches.find(item => item.id === root?.parentBranchId) ?? root;
    const node = root && this.map?.nodes.find(item => item.id === root.questionNodeId);
    if (!node) return;
    this.aimBranchModelPending.add(branchId);
    void this.plugin.repo
      .resolveTopicModel(node.path, this.map ?? undefined)
      .then(resolved => {
        if (!this.closed && this.aimProgress) this.aimBranchModels.set(branchId, resolved.model);
      })
      .catch(() => {})
      .finally(() => this.aimBranchModelPending.delete(branchId));
  }
  private aimStageText(): string {
    const progress = this.aimProgress;
    if (!progress) return "";
    const elapsed = Math.round((Date.now() - progress.startedAt) / 1000);
    const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
    const targets = [...progress.targets.values()];
    const stage =
      progress.stage === "research" && targets.length
        ? t(
            "ui.aim_stage_research_0_1",
            targets.filter(item => item.state === "done" || item.state === "skipped").length,
            targets.length
          )
        : t(AIM_STAGE_KEYS[progress.stage] ?? "ui.aim_stage_research");
    const model = this.aimBranchModels.get(progress.branchId);
    const shown = model ? t("ui.progress_stage_with_model_0_1", stage, this.plugin.modelLabel(model)) : stage;
    return t("ui.aim_stage_with_elapsed_0_1", shown, clock);
  }
  /** One-second tick: rewrite only the progress texts; stop when the run is over. */
  private paintAimProgress(): void {
    if (this.closed || !this.aimBusy || !this.aimProgress) {
      if (!this.aimBusy) this.stopAimProgress();
      return;
    }
    this.aimProgressEls.get("status")?.setText(this.aimStageText());
    for (const [id, target] of this.aimProgress.targets)
      this.aimProgressEls.get(id)?.setText(this.aimTargetText(target));
  }
  /** Cards for the planned subtopics whose research notes do not exist yet, beside their question. */
  private renderAimPendingCards(shown: MapNode[]): void {
    const progress = this.aimProgress;
    if (!progress || !this.aimBusy || !this.stageEl || !this.map?.aim) return;
    const branch = this.map.aim.branches.find(item => item.id === progress.branchId);
    const question = branch && shown.find(node => node.id === branch.questionNodeId);
    if (!branch || !question) return;
    const saved = new Set(branch.results.filter(item => item.kind === "research").map(item => item.subtopicId));
    const children = shown.filter(node => node.parentId === question.id);
    const x = children.length ? Math.max(...children.map(node => node.x)) : question.x + 420;
    let y = children.length ? Math.max(...children.map(node => node.y)) + 150 : question.y;
    for (const [id, target] of progress.targets) {
      if (saved.has(id)) continue;
      const card = this.stageEl.createDiv("vam-node vam-aim-pending");
      card.dataset.status = target.state === "searching" ? "running" : target.state;
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
      card.setAttr("aria-hidden", "true");
      card.createEl("strong", { text: target.title });
      this.aimProgressEls.set(
        id,
        card.createEl("p", { cls: "vam-aim-pending-state", text: this.aimTargetText(target) })
      );
      y += 120;
    }
  }
  /** Speaks a stage (or the slow notice) once, when it changes. The streaming preview never goes through here. */
  private announceResearchStage(path: string): void {
    const node = this.map?.nodes.find(item => item.path === path);
    this.announceStage(path, (node && this.notes.get(node.id)?.title) ?? path);
  }
  private announceStage(key: string, title: string): void {
    const progress = this.plugin.researchProgress?.get(key);
    if (!progress) {
      this.announcedStages.delete(key);
      return;
    }
    const signature = `${progress.stage}|${progress.slow ? 1 : 0}`;
    if (this.announcedStages.get(key) === signature) return;
    this.announcedStages.set(key, signature);
    this.announcer?.setText(
      t(
        "ui.research_announcement_0_1",
        title,
        progress.slow ? t("ui.research_slow_waiting") : this.researchStageText(progress)
      )
    );
  }
  private researchSig(progress: ResearchProgress | undefined): string {
    return progress
      ? [progress.stage, progress.query ?? "", progress.slow ? 1 : 0, progress.resend ? 1 : 0].join("|")
      : "";
  }
  private researchStageText(progress: ResearchProgress): string {
    const stage = this.researchStageName(progress);
    return progress.model
      ? t("ui.progress_stage_with_model_0_1", stage, this.plugin.modelLabel(progress.model))
      : stage;
  }
  private researchStageName(progress: ResearchProgress): string {
    switch (progress.stage) {
      case "searching":
        return progress.query ? t("ui.research_stage_searching_0", progress.query) : t("ui.research_stage_searching");
      case "reading":
        return t("ui.research_stage_reading");
      case "writing":
        return t("ui.research_stage_writing");
      case "charts":
        return t("ui.research_stage_charts");
      default:
        return t("ui.research_stage_waiting");
    }
  }
  private researchElapsedText(startedAt: number): string {
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    // The stage is a separate element (the screen-reader announcement), so only the separator and the clock are here.
    return t("ui.aim_stage_with_elapsed_0_1", "", clock);
  }
  private trackResearchElapsed(element: HTMLElement, startedAt: number): void {
    this.researchElapsed.set(element, startedAt);
    if (this.researchTick === null) this.researchTick = window.setInterval(() => this.tickResearch(), 1000);
  }
  /** One-second tick: rewrite only the elapsed texts, never the cards; stops when none is left on screen. */
  private tickResearch(): void {
    for (const [element, startedAt] of [...this.researchElapsed]) {
      if (this.closed || !element.isConnected) this.researchElapsed.delete(element);
      else element.setText(this.researchElapsedText(startedAt));
    }
    if (!this.researchElapsed.size && this.researchTick !== null) {
      window.clearInterval(this.researchTick);
      this.researchTick = null;
    }
  }
  /** The progress key of this map's multi-select synthesis or AI merge (a name no Vault path can have). */
  private taskProgressKey(kind: "integration" | "merge", mapPath = this.path): string {
    return `${TASK_PROGRESS_PREFIX}${kind}:${mapPath}`;
  }
  /**
   * Stage, seconds and the unsaved preview of one synthesis or merge request. `key` is the note path (child synthesis) or a
   * task key. The entry belongs to the caller: `end()` runs when the answer arrives (before anything is written), and again
   * in the caller's finally. A key that already has an entry (a chart step of that note) is left alone.
   */
  private startTaskProgress(key: string, model: string): { observer?: ResearchObserver; end: () => void } {
    const progress = this.plugin.researchProgress;
    if (!progress || progress.get(key)) return { end: () => {} };
    let attempt = "starting";
    progress.begin(key, attempt, Date.now(), model);
    return {
      observer: {
        onAttempt: id => {
          attempt = id;
          progress.newAttempt(key, id, Date.now());
        },
        onStage: (id, stage, query) => progress.stage(key, id, stage, Date.now(), query),
        onPreview: (id, fields) => progress.preview(key, id, fields ?? {})
      },
      end: () => progress.end(key, attempt)
    };
  }
  /** Stage text, seconds and the preview line under a synthesis or merge status bar. */
  private renderTaskProgress(bar: HTMLElement, parent: HTMLElement, key: string): void {
    const progress = this.plugin.researchProgress?.get(key);
    if (!progress) {
      this.researchSigs.delete(key);
      this.taskPreviewEls.delete(key);
      return;
    }
    this.researchSigs.set(key, this.researchSig(progress));
    // Both are hidden from screen readers: the stage is spoken by the view's announcer, and the seconds tick every second.
    const stageEl = bar.createSpan({ cls: "vam-research-stage", text: this.researchStageText(progress) });
    stageEl.setAttr("aria-hidden", "true");
    const elapsedEl = bar.createSpan({
      cls: "vam-research-elapsed",
      text: this.researchElapsedText(progress.startedAt)
    });
    elapsedEl.setAttr("aria-hidden", "true");
    this.trackResearchElapsed(elapsedEl, progress.startedAt);
    // A sibling of the bar, not inside it: the live region never reads the streaming text.
    const preview = parent.createDiv({ cls: "vam-task-preview" });
    this.taskPreviewEls.set(key, preview);
    this.paintTaskPreview(key);
  }
  /** Plain text only (never Markdown) and no render: the summary being written, which nothing has saved yet. */
  private paintTaskPreview(key: string): void {
    const element = this.taskPreviewEls.get(key);
    if (!element) return;
    const text = this.plugin.researchProgress?.get(key)?.preview?.summary;
    element.hidden = !text;
    if (!text) {
      if (element.hasClass("is-preview")) {
        element.removeClass("is-preview");
        element.empty();
      }
      return;
    }
    if (!element.hasClass("is-preview")) this.fillCardPreview(element, text);
    else element.querySelector<HTMLElement>(".vam-card-preview-text")?.setText(text);
  }
  private onResearchProgress(path: string): void {
    if (this.closed || !this.map || !this.stageEl) return;
    if (path.startsWith(TASK_PROGRESS_PREFIX)) {
      const kind =
        path === this.taskProgressKey("integration")
          ? "integration"
          : path === this.taskProgressKey("merge")
            ? "merge"
            : null;
      if (!kind) return;
      this.paintTaskPreview(path);
      // The labels end in punctuation ("Merging:", "…") that the "{0}: {1}" announcement would double.
      this.announceStage(
        path,
        t(kind === "integration" ? "ui.integration_running" : "ui.merge_bar_title").replace(/\s*[:：…]+\s*$/u, "")
      );
      if (this.researchSig(this.plugin.researchProgress.get(path)) !== (this.researchSigs.get(path) ?? ""))
        this.scheduleResearchRender();
      return;
    }
    if (!this.map.nodes.some(node => node.path === path)) return;
    this.paintHoverResearch();
    this.paintCardPreview(path);
    this.announceResearchStage(path);
    if (this.researchSig(this.plugin.researchProgress.get(path)) !== (this.researchSigs.get(path) ?? ""))
      this.scheduleResearchRender();
  }
  private scheduleResearchRender(): void {
    if (this.researchRenderTimer !== null) return;
    this.researchRenderTimer = window.setTimeout(() => {
      this.researchRenderTimer = null;
      if (this.closed) return;
      // Like AIM progress: never interrupt a drag or an open input; try again shortly instead.
      const typing = this.typingInField();
      if (this.dragging || typing) this.scheduleResearchRender();
      else this.renderPreservingFocus();
    }, 150);
  }
  /** Marks a card summary as the unsaved preview: a label plus plain text (never Markdown). Not a live region. */
  private fillCardPreview(summary: HTMLElement, text: string): void {
    summary.addClass("is-preview");
    summary.empty();
    summary.createSpan({ cls: "vam-card-preview-label", text: t("ui.research_preview_label") });
    summary.createSpan({ cls: "vam-card-preview-text", text });
    summary.title = text;
  }
  /**
   * Streams the summary preview into the card itself. Text only: no render, nothing is saved. Once the preview is gone
   * (Stop, stale, failure, a retraction) the stored summary comes back; success is drawn by the note refresh.
   */
  private paintCardPreview(path: string): void {
    const node = this.map?.nodes.find(item => item.path === path);
    const card = node && this.cardEls.get(node.id);
    if (!node || !card) return;
    const title = card.querySelector<HTMLElement>(".vam-card-title");
    let summary = card.querySelector<HTMLElement>(".vam-card-summary");
    const text = this.plugin.researchProgress?.get(path)?.preview?.summary;
    if (text) {
      if (!summary && title) {
        summary = card.createEl("p", { cls: "vam-card-summary" });
        title.after(summary);
      }
      if (!summary) return;
      if (!summary.hasClass("is-preview")) this.fillCardPreview(summary, text);
      else {
        summary.querySelector<HTMLElement>(".vam-card-preview-text")?.setText(text);
        summary.title = text;
      }
      this.fitKindShape(card, this.topicKindOf(node.id));
      return;
    }
    if (!summary?.hasClass("is-preview")) return;
    const note = this.notes.get(node.id);
    if (!note || isPlaceholder(note.summary)) summary.remove();
    else {
      summary.removeClass("is-preview");
      summary.setText(note.summary);
      summary.title = note.summary;
    }
    this.fitKindShape(card, this.topicKindOf(node.id));
  }
  /** Plain text only (never Markdown): the answer being written, which nothing has saved yet. */
  private paintHoverResearch(): void {
    const hover = this.hoverResearch;
    if (!hover || !this.hoverCard) return;
    const preview = this.plugin.researchProgress?.get(hover.path)?.preview;
    hover.block.hidden = !preview;
    hover.summary.setText(preview?.summary ?? "");
    hover.detail.setText(preview?.detailTail ?? "");
    hover.detail.hidden = !preview?.detailTail;
  }
  private renderResearchProgress(parent: HTMLElement): void {
    const nodes = this.map?.nodes ?? [];
    const done = nodes.filter(node => this.notes.get(node.id)?.status === "completed").length;
    const progress = parent.createDiv("vam-research-progress");
    progress.setAttr("role", "progressbar");
    progress.setAttr("aria-valuemin", "0");
    progress.setAttr("aria-valuemax", String(nodes.length));
    progress.setAttr("aria-valuenow", String(done));
    progress.setAttr("aria-label", t("ui.research_progress_0_of_1", done, nodes.length));
    progress.createSpan({
      cls: "vam-research-progress-label",
      text: t("ui.research_progress_0_of_1", done, nodes.length)
    });
    const fill = progress.createDiv("vam-research-progress-track").createDiv("vam-research-progress-fill");
    fill.style.width = `${nodes.length ? (done / nodes.length) * 100 : 0}%`;
    const running = nodes.filter(
      node => this.plugin.running?.has(node.path) || this.plugin.quickExpandPending?.has(node.path)
    ).length;
    if (running) progress.createSpan({ cls: "vam-status vam-status-running", text: t("ui.researching_0", running) });
  }
  private button(parent: HTMLElement, text: string, action: () => void, disabled = false): HTMLButtonElement {
    const button = parent.createEl("button", { text });
    if (this.renderingCard) button.tabIndex = -1;
    button.disabled = disabled;
    button.addEventListener("click", event => {
      event.stopPropagation();
      action();
    });
    return button;
  }
  /** Returns the snapshots its history entry restores (taken after any conflict was resolved), or null when nothing ran. */
  private async mapChange(change: (map: MapDocument) => void, rebuildDerivedData = true): Promise<void> {
    await this.mapChangeSnapshots(change, rebuildDerivedData);
  }
  /** Compares Map.md on disk with the map in memory; when they differ the conflict window decides and history is cleared. */
  private async resolveMapConflict(): Promise<boolean> {
    if (!this.map) return false;
    const disk = await this.plugin.repo.readMap(this.path);
    const structure = (map: MapDocument): string => JSON.stringify({ ...map, viewport: null });
    if (structure(disk) === structure(this.map)) return false;
    const local = clone(this.map);
    // A cross-map cut refuses to touch this map while its conflict window is still open.
    this.conflictOpen = true;
    try {
      this.map = await new Promise<MapDocument>(resolve => new MapConflictModal(this.app, local, disk, resolve).open());
    } finally {
      this.conflictOpen = false;
    }
    this.history.clear();
    return true;
  }
  /** Runs `change` on Map.md through MapTransaction; `created` are notes that already exist and are parked by Undo. */
  private async mapChangeSnapshots(
    change: (map: MapDocument, attachment: AttachmentPath) => void,
    rebuildDerivedData = true,
    created: string[] = [],
    attachment?: { name: string; data: ArrayBuffer }
  ): Promise<{ before: MapDocument; after: MapDocument } | null> {
    if (!this.map) return null;
    const tx = this.beginMapTransaction();
    for (const path of created) tx.create(path, this.plugin.repo.topicFolder(this.path, "Unassigned"), this.map.id);
    // The file is stored (or an identical one reused) inside this step; a failed step trashes only a file it created.
    if (attachment) tx.createAttachment("image", { ...attachment, sourcePath: this.path });
    let before!: MapDocument, after!: MapDocument;
    const viewport = clone(this.map.viewport);
    const opened = this.map;
    try {
      const entry = await tx
        .editMap(this.path, (map, _resolve, attachmentPath) => {
          // Map.md on disk may hold an older viewport: the edit starts from the one on screen, as the in-memory edit did.
          map.viewport = clone(viewport);
          before = clone(map);
          change(map, attachmentPath);
          after = clone(map);
        })
        .commit({ deferRebuild: true });
      this.history.push(entry);
      // Commit is asynchronous: the user may have panned meanwhile, so only a viewport the change itself set is applied.
      // A conflict window replaces this.map with another object (possibly the older file version): the viewport on screen wins then.
      if (this.map && (this.map !== opened || JSON.stringify(after.viewport) !== JSON.stringify(viewport)))
        this.map.viewport = clone(after.viewport);
    } catch (error) {
      this.render();
      throw error;
    }
    // The change is saved and in history; a failing rebuild is reported but leaves it there (Undo stays available).
    const ownership = (map: MapDocument): string =>
      JSON.stringify(map.nodes.map(node => [node.id, node.path, node.parentId]));
    try {
      if (rebuildDerivedData && (ownership(before) !== ownership(after) || created.length > 0))
        await this.plugin.rebuildDerivedData();
    } catch (error) {
      this.render();
      throw error;
    }
    this.render();
    return { before, after };
  }
  /** Removes a topic (or its branch) to Unassigned in one undo step; `adopterId` first takes over its children (merge). */
  private async removeToUnassigned(node: MapNode, branch: boolean, adopterId?: string): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map),
      ids = branch ? new Set([node.id, ...descendants(before.nodes, node.id)]) : new Set([node.id]);
    if (!this.mergeUnlocked(adopterId ? [...ids, adopterId] : ids)) return;
    const removableQuestions = new Set(
      node.aimKind === "question"
        ? before.nodes.filter(item => ids.has(item.id) && item.aimKind === "question").map(item => item.id)
        : []
    );
    this.assertAimReferencesRemain(before, ids, false, removableQuestions);
    const removed = before.nodes.filter(item => ids.has(item.id)),
      parkFolder = this.plugin.repo.topicFolder(this.path, "Unassigned");
    const tx = this.beginMapTransaction();
    for (const item of removed) tx.park(item.path, parkFolder, before.id, "unassigned");
    const entry = await tx
      .editMap(this.path, map => {
        const prior = clone(map);
        const adopted = new Set<string>();
        if (adopterId)
          for (const item of map.nodes)
            if (item.parentId === node.id) {
              item.parentId = adopterId;
              adopted.add(item.id);
              for (const id of descendants(map.nodes, item.id)) adopted.add(id);
            }
        map.nodes = removeNodes(map.nodes, node.id, branch);
        if (adopterId) {
          removeTopicRelationsFor(
            map,
            [...ids].filter(id => id !== node.id)
          );
          this.takeRetargetDrops(retargetTopicRelations(map, [node.id], adopterId));
        } else removeTopicRelationsFor(map, ids);
        if (adopterId && adopted.size) {
          const adopter = map.nodes.find(item => item.id === adopterId);
          if (adopter) adopter.collapsed = false;
          map.nodes = arrangeNewBranch(map.nodes, adopterId, adopted, this.cardHeightOf, undefined, layoutOf(map));
        }
        this.removeAimReferences(map, ids, prior.nodes);
      })
      .commit();
    this.selected = null;
    this.multiSelected.clear();
    this.history.push(entry);
    if (adopterId) this.noticeDroppedCycles();
    await this.refreshAfterSavedChange();
  }
  private mergeBusy(node: MapNode, except?: MergeTask): boolean {
    const batch = this.plugin.expansionBatches?.get(this.multiResearchKey()),
      task = this.integrationTask;
    return !!(
      this.plugin.relevanceGrades?.get(this.path)?.status === "running" ||
      this.plugin.running?.has(node.path) ||
      this.plugin.quickExpandPending?.has(node.path) ||
      this.plugin.activeTasks?.has(node.path) ||
      (batch?.status === "running" && (batch.currentPath === node.path || batch.queuedPaths.includes(node.path))) ||
      (task?.state === "running" && task.mapPath === this.path && task.sources.some(source => source.id === node.id)) ||
      this.isMerging(node.id, except)
    );
  }
  /** True while an AI merge on this map still holds the card (running or being written): the card is locked. */
  private isMerging(nodeId: string, except?: MergeTask): boolean {
    return [...(this.mergeTasks?.values() ?? [])].some(
      merge => merge !== except && merge.mapPath === this.path && merge.sources.some(source => source.id === nodeId)
    );
  }
  /** A card and everything below it. */
  private branchIds(id: string): string[] {
    return [id, ...(this.map ? descendants(this.map.nodes, id) : [])];
  }
  /** Refuses a change to merging cards with a Notice; true when `ids` hold none. */
  private mergeUnlocked(ids: Iterable<string>): boolean {
    for (const id of ids)
      if (this.isMerging(id)) {
        new Notice(t("ui.merge_locked"));
        return false;
      }
    return true;
  }
  private mergeCheck(ids: Iterable<string> = this.multiSelected, except?: MergeTask): MergeEligibility {
    return mergeEligibility({
      ids,
      nodes: this.map?.nodes ?? [],
      hasNote: id => this.notes.has(id),
      busy: node => this.mergeBusy(node, except)
    });
  }
  /** Asks for the merged topic's name, then merges in the write queue (which checks everything again). */
  private openMerge(): void {
    if (!this.map || this.map.aim || this.builtIn || this.mergeOpen || !this.multiSelected.size) return;
    // One AI merge per map: a running one is only reported.
    if (this.mergeTasks.has(this.path)) {
      new Notice(t("ui.merge_locked"));
      return;
    }
    const check = this.mergeCheck();
    if (!check.ok) {
      new Notice(t(check.reason));
      return;
    }
    const snapshot = {
      path: this.path,
      mapId: this.map.id,
      parentId: check.parentId,
      targetId: check.targetId,
      sources: check.sources.map(source => ({ id: source.id, path: source.path }))
    };
    const withContent = hasMergeContent(check.sources.map(source => this.notes.get(source.id)));
    this.mergeOpen = true;
    new MergeTopicsModal(
      this.app,
      snapshot.sources.length,
      this.notes.get(check.sources[0].id)?.title ?? "",
      title =>
        this.enqueue(async () => {
          try {
            await this.mergeSelected(title, snapshot);
          } finally {
            this.mergeOpen = false;
          }
        }),
      () => {
        this.mergeOpen = false;
      },
      withContent
        ? { start: (title, started, signal) => this.startMergeDraft(title, snapshot, started, signal) }
        : undefined,
      check.targetId ? (this.notes.get(check.targetId)?.title ?? "") : undefined
    ).open();
  }
  /**
   * The model of a merged topic: the common parent's model like a new subtopic, else the workspace model. In parent mode
   * the parent topic itself is the one whose model counts.
   */
  private async mergeModel(parentId: string | null): Promise<ModelChoice> {
    const parent = parentId ? this.map?.nodes.find(node => node.id === parentId) : undefined;
    const current: ModelChoice = this.plugin.currentModelChoice();
    if (!parent) return current;
    const resolved = await this.plugin.repo.resolveTopicModel(parent.path, this.map ?? undefined);
    return {
      model: resolveMergeModel(resolved.model, current.model),
      reasoning: resolved.reasoning
    };
  }
  /**
   * Starts the AI merge from the dialog. The usage notice comes first (declining leaves the dialog open and starts
   * nothing); once accepted, `started` hides the dialog and the task lives on the cards and the status bar until the
   * merged result is written (no draft review). Resolves false when AI did not start.
   */
  private async startMergeDraft(
    title: string,
    snapshot: {
      path: string;
      mapId: string;
      parentId: string | null;
      targetId?: string | null;
      sources: { id: string; path: string }[];
    },
    started: () => void,
    signal: AbortSignal
  ): Promise<boolean> {
    const stillValid = (): boolean => {
      const check = this.mergeCheck(snapshot.sources.map(source => source.id));
      return (
        !this.closed &&
        !!this.map &&
        this.path === snapshot.path &&
        this.map.id === snapshot.mapId &&
        check.ok &&
        check.targetId === (snapshot.targetId ?? null) &&
        check.sources.every(node => snapshot.sources.find(source => source.id === node.id)?.path === node.path)
      );
    };
    if (!stillValid()) {
      new Notice(t("ui.merge_draft_stale"));
      return false;
    }
    const { model, reasoning } = await this.mergeModel(snapshot.targetId ?? snapshot.parentId);
    let began = false;
    const accepted = await this.plugin.confirmAiUsage(model, async () => {
      if (signal.aborted || !stillValid()) return;
      began = true;
      const task: MergeTask = {
        mapPath: snapshot.path,
        mapId: snapshot.mapId,
        mapTitle: this.map?.title ?? "",
        title,
        sources: snapshot.sources,
        parentId: snapshot.parentId,
        targetId: snapshot.targetId ?? null,
        model,
        reasoning,
        sourceContent: "",
        controller: new AbortController(),
        state: "running",
        progress: ""
      };
      this.mergeTasks.set(snapshot.path, task);
      this.mergeOpen = false;
      started();
      this.render();
      task.run = this.runMergeDraft(task);
    });
    if (accepted && !began && !signal.aborted) new Notice(t("ui.merge_draft_stale"));
    return began;
  }
  private isLiveMergeTask(task: MergeTask): boolean {
    return this.mergeTasks.get(task.mapPath) === task && !task.controller.signal.aborted && !this.closed;
  }
  /** The model call of an AI merge; a stopped, replaced or late run changes nothing. */
  private async runMergeDraft(task: MergeTask): Promise<void> {
    const language = this.plugin.settings.language;
    const progress = this.startTaskProgress(this.taskProgressKey("merge", task.mapPath), task.model);
    try {
      const sourceGroup = await this.topicReferenceGroup(task.sources, "strong", { origin: false });
      if (!this.isLiveMergeTask(task)) return;
      task.sourceContent = JSON.stringify(sourceGroup.documents);
      const request: TaskContext = {
        title: t("ui.merge_ai_untitled"),
        summary: noSummaryYet(language),
        rules: "",
        detail: "",
        task: mergeGoalTask(language),
        ancestors: "",
        referenceGroups: [sourceGroup],
        // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
        referenceDelivery: "direct",
        onProgress: message => {
          if (!this.isLiveMergeTask(task)) return;
          task.progress = message;
          this.render();
        },
        outputLanguage: language,
        mode: "merge",
        researchMode: "local",
        researchDepth: "normal",
        visualMode: "off",
        detailTemplate: this.mapDetailTemplate(language)
      };
      const ask = (context: TaskContext): Promise<AiResult> =>
        // Each request is its own attempt of one entry: the repair request clears the first request's preview.
        this.plugin.askModel(
          context,
          task.model,
          task.reasoning,
          task.controller.signal,
          undefined,
          undefined,
          undefined,
          progress.observer
        );
      /** The sources must still be what the model was given; a change during any request fails with the stale message. */
      const sourcesUnchanged = async (): Promise<boolean> => {
        if (!this.isLiveMergeTask(task)) return false;
        const latest = await this.topicReferenceGroup(task.sources, "strong", { origin: false });
        if (!this.isLiveMergeTask(task)) return false;
        if (JSON.stringify(latest.documents) !== task.sourceContent) throw new Error(t("ui.merge_draft_stale"));
        return true;
      };
      let result = await ask(request);
      if (!(await sourcesUnchanged())) return;
      task.title = mergeTitleFromResult(result, task.title);
      // Programmatic content check, one repair round; whatever is still wrong then is applied with a warning.
      let check = await this.checkMergeResult(task, result);
      if (!check.ok) {
        try {
          const repaired = await ask({
            ...request,
            summary: result.summary,
            detail: result.detail,
            task: mergeRepair(
              language,
              findingList(check.missing, inLanguage(NONE, language)),
              findingList(check.added, inLanguage(NONE, language)),
              task.title
            )
          });
          if (!(await sourcesUnchanged())) return;
          const again = await this.checkMergeResult(task, repaired);
          // A repair that made it worse is not used.
          if (again.missing.length + again.added.length <= check.missing.length + check.added.length) {
            result = repaired;
            check = again;
            task.title = mergeTitleFromResult(result, task.title);
          }
        } catch (error) {
          if (task.controller.signal.aborted || this.closed || !this.isLiveMergeTask(task)) throw error;
          if (error instanceof Error && error.message === t("ui.merge_draft_stale")) throw error;
          this.plugin.recordFailure(t("log.merge_failed"), error);
        }
      }
      // The result is final: the unsaved preview goes away before anything is written.
      progress.end();
      task.state = "applying";
      task.draft = result;
      task.progress = "";
      this.render();
      const previous = this.history.undoEntry;
      await this.confirmMergeDraft(task, result.summary, result.detail);
      const entry = this.history.undoEntry;
      let done = t("ui.merge_done_0", task.title);
      if (!check.ok) {
        const found = check.missing.length + check.added.length;
        this.plugin.recordFailure(
          t("log.merge_check_warning"),
          `${task.title}: missing ${JSON.stringify(check.missing)}; added ${JSON.stringify(check.added)}`
        );
        done = `${done} ${t("ui.merge_check_warning_0", String(found))}`;
      }
      // The Undo button only while this merge is still the newest history step.
      if (entry && entry !== previous)
        backgroundResultNotice(
          done,
          {
            label: t("ui.undo"),
            open: () => {
              if (this.history.undoEntry === entry && !this.closed) this.enqueue(() => this.travel(false));
            }
          },
          MERGE_DONE_NOTICE_MS
        );
      else new Notice(done, MERGE_DONE_NOTICE_MS);
    } catch (error) {
      // Nothing was written (a write that fails midway has already rolled itself back); the task is forgotten.
      const live = this.mergeTasks.get(task.mapPath) === task;
      if (live) this.mergeTasks.delete(task.mapPath);
      if (!this.closed) this.render();
      if (task.controller.signal.aborted || this.closed) return;
      const stale = error instanceof Error && error.message === t("ui.merge_draft_stale");
      new Notice(stale ? t("ui.merge_draft_stale") : this.plugin.recordFailure(t("log.merge_failed"), error));
    } finally {
      progress.end();
    }
  }
  /** A done Notice with Undo while the write is still the newest history step (the merge pattern). */
  private undoNotice(message: string, previous: Action | undefined): void {
    const entry = this.history.undoEntry;
    if (entry && entry !== previous)
      backgroundResultNotice(
        message,
        {
          label: t("ui.undo"),
          open: () => {
            if (this.history.undoEntry === entry && !this.closed) this.enqueue(() => this.travel(false));
          }
        },
        MERGE_DONE_NOTICE_MS
      );
    else new Notice(message, MERGE_DONE_NOTICE_MS);
  }
  /** Stop, or clear a finished one: the run is aborted and forgotten, so a late result changes nothing. */
  private stopMergeTask(task: MergeTask): void {
    if (this.mergeTasks.get(task.mapPath) === task) this.mergeTasks.delete(task.mapPath);
    task.controller.abort();
    this.render();
  }
  /** Compares the merged summary and Detail with what the sources hold (numbers, links, embeds; no invented numbers). */
  private async checkMergeResult(task: MergeTask, result: AiResult): Promise<MergeCheckResult> {
    const notes = await Promise.all(
      task.sources.map(source => this.plugin.repo.readNote(source.path, this.map ?? undefined))
    );
    return checkMergePreservation({
      sourceTexts: notes.flatMap(note => [note.summary, note.detail, note.newFindings]),
      sourceLinkTexts: notes.map(note => note.visualReferences),
      allowedTexts: task.sources.map(source => source.path),
      logHeadings: this.mapDetailTemplate(this.plugin.settings.language)
        .sections.filter(section => section.role === "log")
        .flatMap(section => [section.name, ...section.aliases]),
      mergedTexts: [result.summary, result.detail],
      mergedLinkTexts: result.visualReferences.map(reference => `${reference.imageUrl} ${reference.sourceUrl}`)
    });
  }
  /** Writes the AI merge result through the write queue, which checks the snapshot and the sources again. */
  private confirmMergeDraft(task: MergeTask, summary: string, detail: string): Promise<void> {
    const draft = task.draft;
    if (!draft) return Promise.reject(new Error(t("ui.merge_draft_stale")));
    return this.plugin.mutate(() =>
      this.mergeSelected(
        task.title,
        { path: task.mapPath, mapId: task.mapId, targetId: task.targetId, sources: task.sources },
        {
          summary,
          detail,
          visualReferences: draft.visualReferences,
          formatIssues: draft.formatIssues,
          sourceContent: task.sourceContent,
          task
        }
      )
    );
  }
  /**
   * Replaces the selected sibling topics with one new topic: their Details become sections of the new Detail, their
   * notes go to Unassigned, their subtopics move under the new topic. One history step; a failure puts everything back.
   */
  private async mergeSelected(
    title: string,
    snapshot: { path: string; mapId: string; targetId?: string | null; sources: { id: string; path: string }[] },
    content?: {
      summary: string;
      detail: string;
      visualReferences: AiResult["visualReferences"];
      formatIssues: AiResult["formatIssues"];
      sourceContent: string;
      task: MergeTask;
    }
  ): Promise<void> {
    // An AI result that no longer fits fails loudly and writes nothing (the caller forgets the task); the plain merge
    // just does nothing.
    const stale = (): never => {
      throw new Error(t("ui.merge_draft_stale"));
    };
    if (
      this.closed ||
      !this.map ||
      this.map.aim ||
      this.builtIn ||
      this.path !== snapshot.path ||
      this.map.id !== snapshot.mapId
    ) {
      if (content) stale();
      return;
    }
    if (content && (this.mergeTasks.get(snapshot.path) !== content.task || content.task.state !== "applying")) stale();
    const check = this.mergeCheck(
      snapshot.sources.map(source => source.id),
      content?.task
    );
    if (!check.ok) {
      if (content) stale();
      new Notice(t(check.reason));
      return;
    }
    if (
      (snapshot.targetId ?? null) !== check.targetId ||
      check.sources.some(node => snapshot.sources.find(source => source.id === node.id)?.path !== node.path)
    ) {
      if (content) stale();
      new Notice(t("ui.merge_missing_note"));
      return;
    }
    const sources = check.sources,
      mapPath = this.path,
      repo = this.plugin.repo,
      before = clone(this.map),
      language = this.plugin.settings.language;
    if (content) {
      let latest: string | undefined;
      try {
        latest = JSON.stringify((await this.topicReferenceGroup(sources, "strong", { origin: false })).documents);
      } catch {
        /* An unreadable source is a changed source. */
      }
      if (latest !== content.sourceContent) stale();
    }
    if (check.targetId) return this.mergeIntoParent(title, check.sources, content, before);
    let detail = "";
    if (!content) {
      const sourceNotes: Note[] = [];
      for (const source of sources) sourceNotes.push(await repo.readNote(source.path, before));
      detail = mergedDetail(
        sources.map((_, index) => ({ title: sourceNotes[index].title, detail: sourceNotes[index].detail }))
      );
    }
    const model = content?.task.model ?? (await this.mergeModel(check.parentId)).model;
    // The new topic keeps the type (and a hypothesis its strength) of the first source in reading order.
    const firstNote = this.notes.get(sources[0].id),
      firstKind = firstNote?.topicKind,
      firstStrength = firstNote?.topicKind === "hypothesis" ? firstNote.hypothesisStrength : undefined;
    const created = await repo.createNote(
      sanitizeGeneratedTitle(title),
      model,
      before,
      mapPath,
      check.parentId ? "inherited" : "workspace",
      { ...(content ? {} : { detail }), ...(firstKind ? { topicKind: firstKind } : {}) }
    );
    const parkFolder = repo.topicFolder(mapPath, "Unassigned"),
      viewport = clone(this.map?.viewport ?? before.viewport);
    let entry: TransactionEntry;
    try {
      if (firstStrength) await repo.writeHypothesisStrength(created.path, firstStrength);
      if (content) {
        const detailTemplate = this.mapDetailTemplate(language);
        await repo.updateNote(
          created.path,
          {
            summary: content.summary,
            detail: canonicalDetail(content.detail, noteLanguageOf(language), detailTemplate),
            visualReferences: visualReferencesMarkdown(content.visualReferences, noteLanguageOf(language)),
            prompt: mergeGoalTask(language),
            sourcePaths: sources.map(source => source.path),
            status: "completed",
            ...formatIssuesPatch(content.formatIssues, language)
          },
          { detailTemplate }
        );
      } else
        await repo.updateNote(created.path, {
          sourcePaths: sources.map(source => source.path),
          status: mergedStatus(detail)
        });
      const tx = this.beginMapTransaction().create(created.path, parkFolder, before.id);
      for (const source of sources) tx.park(source.path, parkFolder, before.id, "unassigned");
      entry = await tx
        .editMap(mapPath, map => {
          // Map.md on disk may hold an older viewport: the edit starts from the one on screen.
          map.viewport = clone(viewport);
          const ids = new Set(sources.map(source => source.id)),
            first = map.nodes.find(item => item.id === sources[0].id);
          if (!first || sources.some(source => !map.nodes.some(item => item.id === source.id)))
            throw new Error(t("ui.merge_missing_note"));
          const merged: MapNode = { ...created, parentId: check.parentId, x: first.x, y: first.y, collapsed: false },
            adopted = new Set<string>();
          for (const item of map.nodes)
            if (item.parentId !== null && ids.has(item.parentId)) {
              item.parentId = merged.id;
              adopted.add(item.id);
              for (const id of descendants(map.nodes, item.id)) adopted.add(id);
            }
          map.nodes = map.nodes.flatMap(item => (item.id === first.id ? [merged] : ids.has(item.id) ? [] : [item]));
          this.takeRetargetDrops(retargetTopicRelations(map, ids, merged.id));
          if (adopted.size)
            map.nodes = arrangeNewBranch(map.nodes, merged.id, adopted, this.cardHeightOf, undefined, layoutOf(map));
        })
        .commit({ label: t("ui.merge_topics_history") });
    } catch (error) {
      this.render();
      // The new note is created outside the transaction: park it (never delete it) and rebuild.
      try {
        if (this.app.vault.getAbstractFileByPath(created.path)) {
          const parked = await repo.moveUnique(created.path, parkFolder);
          await repo.setLifecycle(parked, before.id, "", "unassigned");
          await this.plugin.rebuildDerivedData();
        }
      } catch (parkError) {
        const earlier: unknown[] = isTransactionError(error, "rollback-failed")
          ? ((error as Partial<AggregateError>).errors ?? [error])
          : [error];
        throw Object.assign(new AggregateError([...earlier, parkError], t("error.merge_rollback_failed")), {
          kind: "rollback-failed" as const
        });
      }
      throw this.mergeError(error);
    }
    if (content && this.mergeTasks.get(mapPath) === content.task) this.mergeTasks.delete(mapPath);
    this.history.push(this.mergeEntry(entry));
    this.integrationMode = false;
    this.selected = created.id;
    this.multiSelected.clear();
    await this.finishMerge(created.id);
  }
  /**
   * Merge into a parent topic (`sources[0]`): the parent keeps its card, id, path, place and other properties; its
   * Summary and Detail become the merged content (its own content is a source too), the selected subtopics go to
   * Unassigned and their subtopics move under the parent. One history step; a failure puts everything back, including
   * the parent's exact text.
   */
  private async mergeIntoParent(
    title: string,
    sources: MapNode[],
    content:
      | {
          summary: string;
          detail: string;
          visualReferences: AiResult["visualReferences"];
          formatIssues: AiResult["formatIssues"];
          task: MergeTask;
        }
      | undefined,
    before: MapDocument
  ): Promise<void> {
    const [target, ...children] = sources,
      mapPath = this.path,
      repo = this.plugin.repo,
      language = this.plugin.settings.language,
      detailTemplate = this.mapDetailTemplate(language);
    const sourceNotes: Note[] = [];
    for (const source of sources) sourceNotes.push(await repo.readNote(source.path, before));
    const name = title.trim(),
      sourcePaths = [...new Set([...sourceNotes[0].sourcePaths, ...children.map(child => child.path)])];
    let patch: NotePatch;
    if (content) {
      const references = visualReferencesMarkdown(content.visualReferences, noteLanguageOf(language));
      patch = {
        summary: content.summary,
        detail: canonicalDetail(content.detail, noteLanguageOf(language), detailTemplate),
        status: "completed",
        sourcePaths,
        ...(references.trim() ? { visualReferences: references } : {}),
        ...formatIssuesPatch(content.formatIssues, language)
      };
    } else {
      const detail = mergedDetail(sourceNotes.map(note => ({ title: note.title, detail: note.detail })));
      patch = { detail, status: mergedStatus(detail), sourcePaths };
    }
    if (name && name !== sourceNotes[0].title) patch.title = name;
    const parkFolder = repo.topicFolder(mapPath, "Unassigned"),
      viewport = clone(this.map?.viewport ?? before.viewport);
    let entry: TransactionEntry;
    try {
      const tx = this.beginMapTransaction().rewriteNote(target.path, async path => {
        await repo.updateNote(path, patch, { detailTemplate });
      });
      for (const child of children) tx.park(child.path, parkFolder, before.id, "unassigned");
      entry = await tx
        .editMap(mapPath, map => {
          // Map.md on disk may hold an older viewport: the edit starts from the one on screen.
          map.viewport = clone(viewport);
          const ids = new Set(children.map(child => child.id));
          if (
            !map.nodes.some(item => item.id === target.id) ||
            children.some(child => !map.nodes.some(item => item.id === child.id))
          )
            throw new Error(t("ui.merge_missing_note"));
          const adopted = new Set<string>();
          for (const item of map.nodes)
            if (item.parentId !== null && ids.has(item.parentId)) {
              item.parentId = target.id;
              adopted.add(item.id);
              for (const id of descendants(map.nodes, item.id)) adopted.add(id);
            }
          map.nodes = map.nodes.filter(item => !ids.has(item.id));
          this.takeRetargetDrops(retargetTopicRelations(map, ids, target.id));
          if (adopted.size)
            map.nodes = arrangeNewBranch(map.nodes, target.id, adopted, this.cardHeightOf, undefined, layoutOf(map));
        })
        .commit({ label: t("ui.merge_topics_history") });
    } catch (error) {
      this.render();
      throw this.mergeError(error);
    }
    if (content && this.mergeTasks.get(mapPath) === content.task) this.mergeTasks.delete(mapPath);
    this.history.push(this.mergeEntry(entry));
    this.integrationMode = false;
    this.selected = target.id;
    this.multiSelected.clear();
    await this.finishMerge(target.id);
  }
  /** Keeps what a merge's relation retargeting dropped, for the notice that follows the save. */
  private takeRetargetDrops(result: { droppedCycles: number; droppedSamePair: number }): void {
    this.lastDroppedCycles = result.droppedCycles;
    this.lastDroppedSamePair = result.droppedSamePair;
  }
  /** Tells the user how many links the last merge removed: duplicates of a pair, and links that would have formed a cycle (both sentences when both happened). */
  private noticeDroppedCycles(): void {
    if (this.lastDroppedSamePair > 0) new Notice(t("ui.merge_dropped_same_pair_0", String(this.lastDroppedSamePair)));
    if (this.lastDroppedCycles > 0) new Notice(t("ui.merge_dropped_cycles_0", String(this.lastDroppedCycles)));
  }
  /** The merge is saved and in history; a failing reload must not look like the merge failed. */
  private async finishMerge(id: string): Promise<void> {
    this.noticeDroppedCycles();
    try {
      await this.hydrate();
      this.render();
      const merged = this.map?.nodes.find(item => item.id === id);
      if (merged) this.focusNode(merged);
    } catch {
      this.render();
      new Notice(t("ui.merge_saved_refresh_failed"));
    }
  }
  /** What the user is told when the transaction refuses or cannot restore; other errors pass through unchanged. */
  private mergeError(error: unknown): unknown {
    if (isTransactionError(error, "guard"))
      return Object.assign(new Error(t("ui.merge_target_changed")), { kind: "guard" as const });
    if (isTransactionError(error, "rollback-failed"))
      return Object.assign(
        new AggregateError((error as Partial<AggregateError>).errors ?? [error], t("error.merge_rollback_failed")),
        { kind: "rollback-failed" as const }
      );
    return error;
  }
  /** One history step for a merge: the commit's entry, plus the selection clean-up and the merge's own error messages. */
  private mergeEntry(entry: TransactionEntry): TransactionEntry {
    const travel = (work: () => Promise<void>) => async (): Promise<void> => {
      try {
        await work();
      } catch (error) {
        throw this.mergeError(error);
      }
      if (this.selected && !this.map?.nodes.some(item => item.id === this.selected)) this.selected = null;
    };
    return { ...entry, undo: travel(entry.undo), redo: travel(entry.redo) };
  }
  private selectedRoots(): MapNode[] {
    if (!this.map) return [];
    return this.map.nodes.filter(
      node =>
        this.multiSelected.has(node.id) &&
        !this.map!.nodes.some(
          parent => this.multiSelected.has(parent.id) && descendants(this.map!.nodes, parent.id).has(node.id)
        )
    );
  }
  private confirmRemoveSelected(): void {
    if (!this.mergeUnlocked(this.selectedRoots().flatMap(root => this.branchIds(root.id)))) return;
    new ChoiceModal(
      this.app,
      t("ui.remove_selected_topics"),
      t("ui.selected_branches_leave_the_map_their_notes_move_to_unassign"),
      [{ label: t("ui.confirm_removal"), warning: true, action: () => this.enqueue(() => this.removeSelected()) }]
    ).open();
  }
  /**
   * Delete or Backspace on a focused card. A leaf leaves the map at once with an Undo notice (it only moves to
   * Unassigned); a card with subtopics asks first, exactly like the remove tool.
   */
  private removeByKey(node: MapNode): void {
    const map = this.map;
    if (!map || map.aim) return;
    if (map.nodes.some(item => item.parentId === node.id)) {
      this.confirmRemoveNode(node);
      return;
    }
    if (!this.mergeUnlocked([node.id])) return;
    const title = this.notes.get(node.id)?.title ?? node.path;
    // Focus moves to the next sibling, else the previous one, else the parent, so the keyboard user stays in the tree.
    const siblings = map.nodes.filter(item => (item.parentId ?? null) === (node.parentId ?? null));
    const at = siblings.findIndex(item => item.id === node.id);
    const next = siblings[at + 1] ?? siblings[at - 1] ?? map.nodes.find(item => item.id === node.parentId);
    this.enqueue(async () => {
      const previous = this.history.undoEntry;
      this.focusNodeId = next?.id ?? null;
      try {
        await this.removeToUnassigned(node, false);
      } finally {
        this.focusNodeId = null;
      }
      if (this.history.undoEntry !== previous) this.undoNotice(t("ui.removed_0_undo_available", title), previous);
    });
  }
  /** The delete confirmation. `hooks` lets a caller run the chosen removal itself and hear about a cancel. */
  private confirmRemoveNode(
    node: MapNode,
    hooks: { run?: (work: () => Promise<void>) => void; dismissed?: () => void } = {}
  ): void {
    // Refused at the door: the dialog does not open for a card that is merging (or has merging cards in its branch).
    if (!this.mergeUnlocked(this.branchIds(node.id))) {
      hooks.dismissed?.();
      return;
    }
    const run = hooks.run ?? ((work: () => Promise<void>) => this.enqueue(work));
    new ChoiceModal(
      this.app,
      t("ui.remove_from_map"),
      t("ui.the_note_will_move_to_this_topic_s_unassigned_folder_you_can"),
      [
        ...(!this.map?.aim || node.aimKind !== "question"
          ? [
              {
                label: t("ui.remove_only_this_node_children_become_roots"),
                warning: true,
                action: () => run(() => this.removeToUnassigned(node, false))
              }
            ]
          : []),
        {
          label: t("ui.remove_entire_branch"),
          warning: true,
          action: () => run(() => this.removeToUnassigned(node, true))
        }
      ],
      hooks.dismissed
    ).open();
  }
  /** Free images only change on a map the user may edit: not AIM, not the built-in sample, not while picking topics. */
  private canEditCanvasItems(): boolean {
    return !this.builtIn && !this.integrationMode && !this.map?.aim;
  }
  /**
   * Draws the map's free images in one layer at the end of the stage, so Tab reaches them after the topic cards and
   * they paint behind the cards. A file that cannot be found shows a named placeholder; the item stays in the map.
   */
  private renderCanvasItems(): void {
    const stage = this.stageEl,
      items = this.map?.canvasItems;
    if (!stage || !items?.length) return;
    const editable = this.canEditCanvasItems();
    const layer = items.some(item => item.kind === "image") ? stage.createDiv("vam-canvas-items") : null;
    layer?.setAttr("role", "group");
    layer?.setAttr("aria-label", t("ui.canvas_images_group"));
    for (const item of items) {
      if (item.kind !== "image" || !layer) continue;
      const image = item as ImageItem,
        name = image.path.split("/").pop() ?? image.path,
        label = t("ui.canvas_image_label", name),
        el = layer.createDiv("vam-canvas-image");
      el.dataset.itemId = image.id;
      el.setAttr("role", "img");
      el.setAttr("aria-label", label);
      el.tabIndex = 0;
      el.style.left = `${image.x}px`;
      el.style.top = `${image.y}px`;
      el.style.width = `${image.w}px`;
      el.style.height = `${image.h}px`;
      const file = this.app.vault.getAbstractFileByPath(image.path);
      const source = file instanceof TFile ? this.app.vault.getResourcePath?.(file) : undefined;
      const placeholder = (): void => {
        el.empty();
        el.addClass("is-missing");
        el.createSpan({ text: name });
      };
      if (!source) placeholder();
      else {
        const img = el.createEl("img", { attr: { src: source, alt: "", draggable: "false" } });
        img.addEventListener("error", placeholder);
      }
      el.addEventListener("focus", () => el.addClass("is-selected"));
      el.addEventListener("blur", () => el.removeClass("is-selected"));
      if (!editable) continue;
      const handle = el.createDiv("vam-canvas-image-handle");
      handle.setAttr("aria-hidden", "true");
      this.enableCanvasItemDrag(el, handle, image);
      el.addEventListener("keydown", event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        event.preventDefault();
        event.stopPropagation();
        this.enqueue(() => this.removeCanvasItem(image.id));
      });
      if (this.focusItemId === image.id) {
        this.focusItemId = null;
        el.focus({ preventScroll: true });
      }
    }
    this.renderBoundaries(stage, items, editable);
    this.focusItemId = null;
  }
  /**
   * Frames (ticket 43). Each frame is measured from the cards drawn right now (`boundaryBounds` over `cardEls`), so a new
   * layout or a moved card is followed without writing anything; a frame whose members are all absent is not drawn (D8).
   * The layer comes after the image layer, so Tab reaches the frames last, and is painted behind the images (CSS z-index).
   * The label is text only. Only the label chip takes the pointer; the frame area stays click-through.
   */
  private renderBoundaries(stage: HTMLElement, items: readonly CanvasItem[], editable: boolean): void {
    const boundaries = items.filter((item): item is BoundaryItem => item.kind === "boundary");
    if (!boundaries.length) return;
    const rectOf = (id: string): { x: number; y: number; w: number; h: number } | null => {
      const card = this.cardEls.get(id);
      if (!card) return null;
      const box = boxOf(card);
      return { x: box.x, y: box.y, w: box.width, h: box.height };
    };
    let layer: HTMLElement | null = null;
    for (const boundary of boundaries) {
      const box = boundaryBounds(boundary.members, rectOf, BOUNDARY_PAD);
      if (!box) continue;
      if (!layer) {
        layer = stage.createDiv("vam-boundaries");
        layer.setAttr("role", "group");
        layer.setAttr("aria-label", t("ui.canvas_boundaries_group"));
      }
      const label = boundary.label ?? "",
        el = layer.createDiv("vam-boundary");
      el.dataset.itemId = boundary.id;
      el.setAttr("role", "group");
      el.setAttr("aria-label", label ? t("ui.canvas_boundary_label", label) : t("ui.canvas_boundary_default"));
      el.tabIndex = 0;
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
      const chip = el.createSpan({ cls: "vam-boundary-label", text: label });
      if (!label) chip.addClass("is-empty");
      el.addEventListener("focus", () => el.addClass("is-selected"));
      el.addEventListener("blur", () => el.removeClass("is-selected"));
      chip.addEventListener("pointerdown", event => {
        if (event.button === 0) el.focus({ preventScroll: true });
      });
      if (!editable) continue;
      chip.addEventListener("dblclick", event => {
        event.stopPropagation();
        this.editBoundaryLabel(boundary.id);
      });
      chip.addEventListener("contextmenu", event => {
        event.preventDefault();
        event.stopPropagation();
        const menu = new Menu();
        menu.addItem(item =>
          item
            .setTitle(t("ui.canvas_boundary_edit"))
            .setIcon("pencil")
            .onClick(() => this.editBoundaryLabel(boundary.id))
        );
        menu.addItem(item =>
          item
            .setTitle(t("ui.canvas_boundary_remove"))
            .setIcon("trash")
            .onClick(() => this.enqueue(() => this.removeCanvasItem(boundary.id)))
        );
        menu.showAtMouseEvent(event);
      });
      el.addEventListener("keydown", event => {
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        if (!event.shiftKey && (event.key === "Delete" || event.key === "Backspace")) {
          event.preventDefault();
          event.stopPropagation();
          this.enqueue(() => this.removeCanvasItem(boundary.id));
        } else if (!event.shiftKey && (event.key === "Enter" || event.key === "F2")) {
          event.preventDefault();
          event.stopPropagation();
          this.editBoundaryLabel(boundary.id);
        }
      });
      if (this.focusItemId === boundary.id) {
        this.focusItemId = null;
        el.focus({ preventScroll: true });
      }
    }
  }
  /** Asks for a frame's label (blank is allowed) and writes it as one undo step. */
  private editBoundaryLabel(id: string): void {
    const current = (this.map?.canvasItems ?? []).find(
      (item): item is BoundaryItem => item.kind === "boundary" && (item as BoundaryItem).id === id
    );
    if (!current || !this.canEditCanvasItems()) return;
    new NameModal(
      this.app,
      t("ui.canvas_boundary_name"),
      current.label ?? "",
      label => {
        this.focusItemId = id;
        this.enqueue(() => this.renameBoundary(id, label));
      },
      { allowEmpty: true }
    ).open();
  }
  /** Sets or clears (blank) a frame's label. */
  private async renameBoundary(id: string, label: string): Promise<void> {
    const text = label.trim();
    await this.changeCanvasItems(id, items =>
      items.map(item => {
        if (item.kind !== "boundary" || (item as BoundaryItem).id !== id) return item;
        const { label: _old, ...rest } = item as BoundaryItem;
        return text ? { ...rest, label: text } : rest;
      })
    );
  }
  /** Frames the given topics (ids that are cards of this map, deduplicated) with an optional label; one undo step. Returns the new id. */
  private async addBoundary(ids: readonly string[], label: string): Promise<string | null> {
    if (!this.map || this.builtIn || this.map.aim) return null;
    const known = new Set(this.map.nodes.map(node => node.id)),
      members = [...new Set(ids)].filter(id => known.has(id));
    if (!members.length) return null;
    const id = `frame-${randomUUID().slice(0, 8)}`,
      text = label.trim();
    this.focusItemId = id;
    const frame: BoundaryItem = { id, kind: "boundary", members, ...(text ? { label: text } : {}) };
    await this.mapChange(map => {
      const alive = map.nodes.map(node => node.id);
      map.canvasItems = [...pruneBoundaries(map.canvasItems ?? [], alive), frame];
    }, false);
    return id;
  }
  /** The selection bar's "Add frame": asks for the optional label, then frames the selected topics. */
  private openAddBoundary(): void {
    const ids = [...this.multiSelected];
    if (!this.map || this.builtIn || this.map.aim || !ids.length) return;
    new NameModal(
      this.app,
      t("ui.canvas_boundary_name"),
      "",
      label => this.enqueue(async () => void (await this.addBoundary(ids, label))),
      { allowEmpty: true }
    ).open();
  }
  /** One gesture, one pointerup, one undo step: the image follows the pointer on screen and Map.md is written on release. */
  private enableCanvasItemDrag(el: HTMLElement, handle: HTMLElement, image: ImageItem): void {
    const begin = (event: PointerEvent, resize: boolean): void => {
      if (event.button !== 0 || !this.map) return;
      event.stopPropagation();
      event.preventDefault();
      el.focus({ preventScroll: true });
      const start = { x: event.clientX, y: event.clientY },
        zoom = this.map.viewport.zoom || 1,
        from = { x: image.x, y: image.y, w: image.w, h: image.h };
      let dx = 0,
        dy = 0,
        width = from.w,
        done = false;
      el.setPointerCapture?.(event.pointerId);
      const move = (e: PointerEvent): void => {
        dx = (e.clientX - start.x) / zoom;
        dy = (e.clientY - start.y) / zoom;
        if (resize) {
          const ratio = from.h / from.w;
          width = Math.max(from.w + dx, IMAGE_MIN_SIZE, IMAGE_MIN_SIZE / ratio);
          el.style.width = `${width}px`;
          el.style.height = `${width * ratio}px`;
        } else {
          el.style.left = `${from.x + dx}px`;
          el.style.top = `${from.y + dy}px`;
        }
      };
      const settle = (): void => {
        done = true;
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", cancel);
        el.removeEventListener("lostpointercapture", cancel);
      };
      const restore = (): void => {
        el.style.left = `${from.x}px`;
        el.style.top = `${from.y}px`;
        el.style.width = `${from.w}px`;
        el.style.height = `${from.h}px`;
      };
      const up = (): void => {
        if (done) return;
        settle();
        this.focusItemId = image.id;
        if (resize && Math.abs(width - from.w) >= 1) this.enqueue(() => this.resizeCanvasItem(image.id, width));
        else if (!resize && Math.hypot(dx, dy) >= 1)
          this.enqueue(() => this.moveCanvasItem(image.id, Math.round(dx), Math.round(dy)));
        else restore();
      };
      const cancel = (): void => {
        if (done) return;
        settle();
        restore();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", cancel);
      el.addEventListener("lostpointercapture", cancel);
    };
    el.addEventListener("pointerdown", event => {
      if (event.target === handle) return;
      begin(event, false);
    });
    handle.addEventListener("pointerdown", event => begin(event, true));
  }
  /** Writes a canvas-item change as one undo step; an empty list leaves no `canvasItems` field in Map.md. */
  private async changeCanvasItems(id: string, change: (items: readonly CanvasItem[]) => CanvasItem[]): Promise<void> {
    if (!this.map || !this.canEditCanvasItems()) return;
    if (!this.map.canvasItems?.some(item => (item as { id?: unknown }).id === id)) return;
    await this.mapChange(map => {
      // An empty frame (every member gone) is cleared with the next canvas write, so an undo of a topic removal still finds it.
      const next = pruneBoundaries(
        change(map.canvasItems ?? []),
        map.nodes.map(node => node.id)
      );
      if (next.length) map.canvasItems = next;
      else delete map.canvasItems;
    }, false);
  }
  /** Moves a free image by (dx, dy) in map units. */
  private async moveCanvasItem(id: string, dx: number, dy: number): Promise<void> {
    await this.changeCanvasItems(id, items => moveItem(items, id, dx, dy));
  }
  /** Resizes a free image to `width`, keeping its ratio. */
  private async resizeCanvasItem(id: string, width: number): Promise<void> {
    await this.changeCanvasItems(id, items => resizeKeepRatio(items, id, width));
  }
  // ---- Adding free images: drop, paste, "Insert image…" (ticket 30, decisions D5, D6, D11) ---------------------------
  /** Registers the three entries on the canvas; AIM maps, the built-in sample and topic selection mode get none (D11). */
  private setupCanvasImageInput(): void {
    const viewport = this.viewportEl;
    if (!viewport || !this.canEditCanvasItems()) return;
    viewport.addEventListener("dragover", event => this.onCanvasDragOver(event));
    viewport.addEventListener("dragleave", event => this.onCanvasDragLeave(event));
    viewport.addEventListener("drop", event => this.onCanvasDrop(event));
    viewport.addEventListener("contextmenu", event => this.onCanvasContextMenu(event));
    viewport.addEventListener("pointermove", event => this.onCanvasPointerMove(event));
  }
  private onCanvasPointerMove(event: { clientX: number; clientY: number }): void {
    this.lastCanvasPointer = { x: event.clientX, y: event.clientY };
  }
  /** A client point in the stage's own units (what `x` and `y` of a canvas item mean). Null when there is no canvas. */
  private stagePoint(client: { x: number; y: number } | null): { x: number; y: number } | null {
    const viewport = this.viewportEl,
      v = this.map?.viewport;
    if (!viewport || !v) return null;
    const rect = viewport.getBoundingClientRect(),
      zoom = v.zoom || 1,
      inside =
        client && client.x >= rect.left && client.x <= rect.right && client.y >= rect.top && client.y <= rect.bottom;
    const local = inside
      ? { x: client.x - rect.left, y: client.y - rect.top }
      : { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    return { x: Math.round((local.x - v.x) / zoom), y: Math.round((local.y - v.y) / zoom) };
  }
  private hasFiles(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    return !!transfer && ((transfer.files?.length ?? 0) > 0 || Array.from(transfer.types ?? []).includes("Files"));
  }
  private onCanvasDragOver(event: DragEvent): void {
    if (!this.canEditCanvasItems() || !this.hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.viewportEl?.addClass("is-image-drop");
  }
  /** The dashed canvas hint goes away when the drag leaves the canvas (not when it only moves onto a child). */
  private onCanvasDragLeave(event: DragEvent): void {
    const into = event.relatedTarget as Node | null;
    if (into && this.viewportEl?.contains(into)) return;
    this.viewportEl?.removeClass("is-image-drop");
  }
  private onCanvasDrop(event: DragEvent): void {
    this.viewportEl?.removeClass("is-image-drop");
    if (!this.canEditCanvasItems() || !this.hasFiles(event)) return;
    // Any file dropped here stays inside the map: the browser must not open or navigate to it.
    event.preventDefault();
    event.stopPropagation();
    const all = Array.from(event.dataTransfer?.files ?? []),
      images = imageFilesFrom({ files: all });
    const point = this.stagePoint({ x: event.clientX, y: event.clientY });
    for (const other of all.filter(item => !images.includes(item)))
      new Notice(t("ui.canvas_image_refused", other.name || "?"));
    if (images.length && point) this.queueCanvasImages(images, point);
  }
  // ---- Pictures on a card: drop and paste (ticket 32, decisions D5, D6) --------------------------------------------
  /** A card takes a dropped picture only on an ordinary editable map (the same rule as the panel's cover switch). */
  private cardAcceptsImages(node: MapNode): boolean {
    return this.canEditCanvasItems() && this.markersEditable(node);
  }
  private onCardDragOver(event: DragEvent, card: HTMLElement, node: MapNode): void {
    if (!this.cardAcceptsImages(node) || !this.hasFiles(event)) return;
    event.preventDefault();
    // The card owns this drag: the canvas hint steps aside and its handler does not also take the file.
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    this.viewportEl?.removeClass("is-image-drop");
    card.addClass("is-drop-target");
  }
  private onCardDragLeave(event: DragEvent, card: HTMLElement): void {
    const into = event.relatedTarget as Node | null;
    if (into && card.contains(into)) return;
    card.removeClass("is-drop-target");
  }
  private onCardDrop(event: DragEvent, card: HTMLElement, node: MapNode): void {
    card.removeClass("is-drop-target");
    if (!this.cardAcceptsImages(node) || !this.hasFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const all = Array.from(event.dataTransfer?.files ?? []),
      images = imageFilesFrom({ files: all });
    for (const other of all.filter(item => !images.includes(item)))
      new Notice(t("ui.canvas_image_refused", other.name || "?"));
    if (images.length) this.enqueue(() => this.attachCardImages(node, images));
  }
  /**
   * Puts each picture on a topic's card: the file is stored beside the note, `![[…]]` is appended to the note's
   * `## User Notes` section (created when missing) and the first picture also becomes `topic-cover`. One transaction
   * per picture (attachment, note rewrite and Map.md together), so one undo step each. Undo writes the old note text
   * back and keeps the file; redo writes the same text again. A switched or closed map drops the result unwritten.
   */
  private async attachCardImages(node: MapNode, files: File[]): Promise<void> {
    if (!this.map || !this.cardAcceptsImages(node)) return;
    const mapPath = this.path,
      epoch = this.mapOpenEpoch,
      stale = (): boolean => this.closed || this.path !== mapPath || this.mapOpenEpoch !== epoch || !this.map;
    let first = true;
    for (const file of files) {
      const label = file.name || "?";
      let data: ArrayBuffer;
      try {
        if (file.size > IMAGE_MAX_BYTES) {
          new Notice(t("ui.canvas_image_too_large", label));
          continue;
        }
        data = await file.arrayBuffer();
      } catch {
        if (!stale()) new Notice(t("ui.canvas_image_unreadable", label));
        continue;
      }
      if (stale()) return;
      const accepted = acceptImage({ mime: file.type, size: file.size, bytes: data });
      if (!accepted.ok) {
        new Notice(t(accepted.reason === "too-large" ? "ui.canvas_image_too_large" : "ui.canvas_image_refused", label));
        continue;
      }
      const name = safeImageName(file.name, accepted.mime);
      if (!name) continue;
      const setCover = first;
      try {
        // Last check before anything is written: from here the transaction owns the file and its rollback.
        if (stale() || !this.map) return;
        const viewport = clone(this.map.viewport);
        const entry = await this.beginMapTransaction()
          .createAttachment("image", { name, data, sourcePath: node.path })
          .rewriteNote(node.path, async (target, attachment) => {
            const note = this.app.vault.getAbstractFileByPath(target);
            if (!(note instanceof TFile)) throw new Error(target);
            const link = attachment("image");
            await this.app.vault.process(note, content => {
              const withEmbed = appendImageEmbed(content, link);
              return setCover ? withCover(withEmbed, link) : withEmbed;
            });
          })
          .editMap(this.path, map => {
            map.viewport = clone(viewport);
          })
          .commit({ deferRebuild: true, label: t("ui.topic_cover") });
        this.history.push(entry);
        first = false;
        await this.refreshAfterSavedChange();
      } catch (error) {
        new Notice(errorMessage(error));
      }
    }
  }
  private onCanvasContextMenu(event: MouseEvent): void {
    if (!this.canEditCanvasItems()) return;
    const target = event.target as Element | null;
    if (
      !target?.closest ||
      target.closest(".vam-node") ||
      target.closest(".vam-canvas-image") ||
      target.closest(".vam-boundary-label") ||
      target.closest(INTERACTIVE_SELECTOR)
    )
      return;
    const point = this.stagePoint({ x: event.clientX, y: event.clientY });
    if (!point) return;
    event.preventDefault();
    const menu = new Menu();
    menu.addItem(item =>
      item
        .setTitle(t("ui.canvas_image_insert"))
        .setIcon("image-plus")
        .onClick(() => this.openCanvasImagePicker(point))
    );
    menu.showAtMouseEvent(event);
  }
  /** The system file picker, images only; the chosen files take the same path as a drop. */
  private openCanvasImagePicker(point: { x: number; y: number }): void {
    const input = this.contentEl.createEl("input", {
      cls: "vam-sr-only",
      attr: { type: "file", accept: "image/*", multiple: "" }
    });
    input.addEventListener("change", () => {
      const chosen = Array.from(input.files ?? []);
      input.remove();
      if (chosen.length) this.queueCanvasImages(chosen, point);
    });
    input.click();
  }
  /**
   * Paste (D6): called after the private format was ruled out. Image files with no selected topic become free images
   * at the last pointer position (the viewport centre when there is none). With a selected topic the picture belongs
   * on the card (ticket 32, P5): nothing is consumed here, so plain text still reaches the clipboard group.
   * Returns true when it took the event.
   */
  private pasteCanvasImages(event: ClipboardEvent): boolean {
    if (!this.canEditCanvasItems()) return false;
    const images = imageFilesFrom({ files: Array.from(event.clipboardData?.files ?? []) });
    if (!images.length) return false;
    // A selected topic (the one the panel shows) takes the picture on its card; other selections leave it alone.
    // Clipboard text next to the picture (a spreadsheet range, say) still goes to the outline in the clipboard group.
    const target = this.map?.nodes.find(item => item.id === this.selected);
    if (target && this.cardAcceptsImages(target) && !event.clipboardData?.getData("text/plain")) {
      event.preventDefault();
      this.enqueue(() => this.attachCardImages(target, images));
      return true;
    }
    if (this.selected || this.multiSelected.size) return false;
    const point = this.stagePoint(this.lastCanvasPointer);
    if (!point) return false;
    event.preventDefault();
    this.queueCanvasImages(images, point);
    return true;
  }
  /** Fences the gesture on this map and this open of it, then queues the writes. */
  private queueCanvasImages(files: File[], point: { x: number; y: number }): void {
    this.enqueue(() => this.insertCanvasImages(files, point));
  }
  /**
   * Reads each file, lets `acceptImage` decide, and only then writes: the attachment and the new canvas item in one
   * transaction (one undo step per picture). The fence compares the map path and open epoch taken before the read;
   * a switched or closed map drops the result without writing anything. A refusal or failure is a Notice.
   */
  private async insertCanvasImages(files: File[], point: { x: number; y: number }): Promise<void> {
    if (!this.canEditCanvasItems()) return;
    const path = this.path,
      epoch = this.mapOpenEpoch,
      stale = (): boolean => this.closed || this.path !== path || this.mapOpenEpoch !== epoch || !this.map;
    let offset = 0;
    for (const file of files) {
      const label = file.name || "?";
      let data: ArrayBuffer;
      try {
        if (file.size > IMAGE_MAX_BYTES) {
          new Notice(t("ui.canvas_image_too_large", label));
          continue;
        }
        data = await file.arrayBuffer();
      } catch {
        if (!stale()) new Notice(t("ui.canvas_image_unreadable", label));
        continue;
      }
      if (stale()) return;
      const accepted = acceptImage({ mime: file.type, size: file.size, bytes: data });
      if (!accepted.ok) {
        new Notice(t(accepted.reason === "too-large" ? "ui.canvas_image_too_large" : "ui.canvas_image_refused", label));
        continue;
      }
      const name = safeImageName(file.name, accepted.mime);
      if (!name) continue;
      const natural = imageSize(data) ?? { width: 240, height: 160 },
        scale = Math.min(1, 320 / Math.max(natural.width, natural.height)),
        w = Math.max(IMAGE_MIN_SIZE, Math.round(natural.width * scale)),
        h = Math.max(IMAGE_MIN_SIZE, Math.round(natural.height * scale)),
        id = `img-${randomUUID().slice(0, 8)}`,
        x = point.x + offset,
        y = point.y + offset;
      try {
        // Last check before anything is written: from here the transaction owns the file and its rollback.
        if (stale()) return;
        this.focusItemId = id;
        await this.mapChangeSnapshots(
          (map, attachment) => {
            map.canvasItems = addImage(map.canvasItems ?? [], { id, path: attachment("image"), x, y, w, h });
          },
          false,
          [],
          { name, data }
        );
        offset += 24;
      } catch (error) {
        this.focusItemId = null;
        new Notice(errorMessage(error));
      }
    }
  }
  /** Removes the reference only; the image file stays in the Vault. */
  private async removeCanvasItem(id: string): Promise<void> {
    this.focusItemId = null;
    await this.changeCanvasItems(id, items => removeItem(items, id));
  }
  private async removeSelected(): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map),
      ids = new Set<string>();
    const roots = this.selectedRoots(),
      removableQuestions = new Set<string>();
    for (const root of roots) {
      const branchIds = new Set([root.id, ...descendants(before.nodes, root.id)]);
      for (const id of branchIds) ids.add(id);
      if (root.aimKind === "question")
        for (const item of before.nodes)
          if (branchIds.has(item.id) && item.aimKind === "question") removableQuestions.add(item.id);
    }
    if (!this.mergeUnlocked(ids)) return;
    this.assertAimReferencesRemain(before, ids, false, removableQuestions);
    const removed = before.nodes.filter(node => ids.has(node.id)),
      parkFolder = this.plugin.repo.topicFolder(this.path, "Unassigned"),
      viewport = clone(this.map.viewport);
    const tx = this.beginMapTransaction();
    for (const node of removed) tx.park(node.path, parkFolder, before.id, "unassigned");
    let entry: TransactionEntry;
    try {
      entry = await tx
        .editMap(this.path, map => {
          // Map.md on disk may hold an older viewport: the edit starts from the one on screen.
          map.viewport = clone(viewport);
          const prior = clone(map);
          map.nodes = map.nodes.filter(node => !ids.has(node.id));
          removeTopicRelationsFor(map, ids);
          this.removeAimReferences(map, ids, prior.nodes);
        })
        .commit();
    } catch (error) {
      this.render();
      if (isTransactionError(error, "rollback-failed"))
        throw Object.assign(
          new AggregateError(
            (error as Partial<AggregateError>).errors ?? [error],
            t("error.batch_remove_rollback_failed")
          ),
          { kind: "rollback-failed" as const }
        );
      throw error;
    }
    this.selected = null;
    this.multiSelected.clear();
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  private chooseSelectedParent(copyNodes: boolean): void {
    if (!this.map) return;
    const roots = this.selectedRoots();
    if (!this.mergeUnlocked(roots.flatMap(root => this.branchIds(root.id)))) return;
    new TopicTreeModal(
      this.app,
      copyNodes ? t("ui.copy_to") : t("ui.move_to"),
      t("ui.choose_a_new_parent_topic"),
      this.map.nodes,
      target => this.notes.get(target.id)?.title ?? target.path,
      target => copyNodes || roots.every(root => canParent(this.map!.nodes, root.id, target.id)),
      target =>
        this.enqueue(() => (copyNodes ? this.copySelected(target) : this.moveBranches(this.selectedRoots(), target)))
    ).open();
  }
  /**
   * Moves the branches under `roots` below `target` (null = to the top level), as one history entry. Each branch keeps
   * its own descendants; the moved branches are laid out once, in the same entry.
   */
  private async moveBranches(roots: MapNode[], target: MapNode | null): Promise<void> {
    if (!this.map) return;
    if (!this.mergeUnlocked([...(target ? [target.id] : []), ...roots.map(root => root.id)])) return;
    this.assertAimReferencesRemain(this.map, new Set(roots.map(root => root.id)), true);
    await this.mapChange(map => {
      const moved = new Set<string>();
      const branchOf = new Map<string, Set<string>>();
      for (const root of roots) {
        if (target && !canParent(map.nodes, root.id, target.id))
          throw new Error(t("ui.circular_links_are_not_allowed"));
        map.nodes.find(item => item.id === root.id)!.parentId = target?.id ?? null;
        const branch = new Set([root.id, ...descendants(map.nodes, root.id)]);
        branchOf.set(root.id, branch);
        for (const id of branch) moved.add(id);
      }
      if (target) {
        map.nodes.find(node => node.id === target.id)!.collapsed = false;
        // One layout for the moved branches under the target, in the same history entry as the move.
        map.nodes = arrangeNewBranch(map.nodes, target.id, moved, this.cardHeightOf, undefined, layoutOf(map));
      } else {
        for (const root of roots)
          map.nodes = arrangeNewTree(map.nodes, root.id, branchOf.get(root.id)!, this.cardHeightOf, layoutOf(map));
      }
    });
    this.multiSelected.clear();
    this.render();
  }
  private assertAimReferencesRemain(
    map: MapDocument,
    ids: Set<string>,
    moving = false,
    removableQuestionNodeIds = new Set<string>()
  ): void {
    const data = map.aim;
    if (!data) return;
    const protectedIds = new Set<string>();
    const removableBranchIds = new Set(
      data.branches.filter(branch => removableQuestionNodeIds.has(branch.questionNodeId)).map(branch => branch.id)
    );
    for (const branch of data.branches) {
      if (!removableBranchIds.has(branch.id)) {
        protectedIds.add(branch.questionNodeId);
        for (const result of branch.results) protectedIds.add(result.nodeId);
      }
    }
    for (const draft of data.resultDrafts ?? [])
      if (!removableBranchIds.has(draft.branchId)) protectedIds.add(draft.nodeId);
    for (const pending of data.pendingCommits)
      if (!removableBranchIds.has(pending.branchId)) protectedIds.add(pending.nodeId);
    if (
      data.questionDraft &&
      (ids.has(data.questionDraft.parentId) || removableBranchIds.has(data.questionDraft.parentBranchId ?? ""))
    )
      throw new Error("A AIM question is still being saved and cannot be removed yet.");
    if (
      (data.resultDrafts ?? []).some(draft => removableBranchIds.has(draft.branchId)) ||
      data.pendingCommits.some(commit => removableBranchIds.has(commit.branchId))
    )
      throw new Error("A AIM result is still being saved and cannot be removed yet.");
    if ([...ids].some(id => protectedIds.has(id)))
      throw new Error(
        moving
          ? "AIM question and result nodes referenced by saved branches cannot be moved."
          : "AIM question and result nodes referenced by saved branches cannot be removed."
      );
    for (const run of data.runs)
      if (
        removableBranchIds.has(run.branchId) &&
        run.attempts.some(attempt => attempt.status === "running" || attempt.status === "saving")
      )
        throw new Error("A AIM branch is still running and cannot be removed yet.");
  }
  private removeAimReferences(
    map: MapDocument,
    removedNodeIds: Set<string>,
    originalNodes: MapNode[] = map.nodes
  ): void {
    const data = map.aim;
    if (!data) return;
    for (const question of originalNodes.filter(node => removedNodeIds.has(node.id) && node.aimQuestion)) {
      const parent = map.nodes.find(node => node.id === question.parentId && !removedNodeIds.has(node.id));
      if (parent)
        parent.aimDismissedQuestionRequestIds = [
          ...new Set([...(parent.aimDismissedQuestionRequestIds ?? []), question.aimQuestion!.requestId])
        ];
    }
    const removedBranchIds = new Set(
      data.branches.filter(branch => removedNodeIds.has(branch.questionNodeId)).map(branch => branch.id)
    );
    data.branches = data.branches.filter(branch => !removedBranchIds.has(branch.id));
    for (const branch of data.branches)
      if (branch.parentBranchId && removedBranchIds.has(branch.parentBranchId)) branch.parentBranchId = null;
    data.runs = data.runs.filter(run => !removedBranchIds.has(run.branchId));
    if (data.resultDrafts)
      data.resultDrafts = data.resultDrafts.filter(
        draft => !removedBranchIds.has(draft.branchId) && !removedNodeIds.has(draft.nodeId)
      );
    data.pendingCommits = data.pendingCommits.filter(
      commit => !removedBranchIds.has(commit.branchId) && !removedNodeIds.has(commit.nodeId)
    );
    if (
      data.questionDraft &&
      (removedNodeIds.has(data.questionDraft.parentId) || removedBranchIds.has(data.questionDraft.parentBranchId ?? ""))
    )
      delete data.questionDraft;
    for (const node of map.nodes) {
      if (node.aimConvergesFromNodeIds)
        node.aimConvergesFromNodeIds = node.aimConvergesFromNodeIds.filter(id => !removedNodeIds.has(id));
      if (node.aimQuestion?.parentBranchId && removedBranchIds.has(node.aimQuestion.parentBranchId))
        node.aimQuestion.parentBranchId = null;
    }
  }
  private async copySelected(target: MapNode): Promise<void> {
    await this.copyBranches(this.selectedRoots(), target, {});
  }
  /**
   * Duplicates the branches under `roots` below `target` (null = as new top-level trees), as one transaction. Copy to…
   * gives each copy the "copy" suffix; a paste keeps the title (`keepTitle`) and may add relations between copied
   * topics, given by the original ids. Returns the new top topics.
   */
  private async copyBranches(
    roots: MapNode[],
    target: MapNode | null,
    options: {
      keepTitle?: boolean;
      relations?: readonly { kind: TopicRelationKind; from: string; to: string; description?: string }[];
    }
  ): Promise<MapNode[]> {
    if (!this.map) return [];
    const before = clone(this.map);
    if (
      !this.mergeUnlocked([
        ...(target ? [target.id] : []),
        ...roots.flatMap(root => [root.id, ...descendants(before.nodes, root.id)])
      ])
    )
      return [];
    const repo = this.plugin.repo,
      replacement = new Map<string, string>();
    return this.writeNewBranches(before, target, async (copies, pairs, relations) => {
      for (const root of roots) {
        const branch: MapNode[] = [];
        const append = (node: MapNode): void => {
          branch.push(node);
          for (const child of before.nodes.filter(item => item.parentId === node.id)) append(child);
        };
        append(root);
        for (const original of branch) {
          const copy = await repo.duplicateNote(
            original.path,
            before,
            this.path,
            options.keepTitle ? { keepTitle: true } : {}
          );
          replacement.set(original.id, copy.id);
          copy.parentId =
            original.id === root.id
              ? (target?.id ?? null)
              : (replacement.get(original.parentId!) ?? target?.id ?? null);
          copy.x = (target ? target.x + 340 : 80) + (original.x - root.x);
          copy.y = (target ? target.y : 80) + roots.indexOf(root) * 220 + (original.y - root.y);
          copies.push(copy);
          pairs.push({ from: original.path, to: copy.path });
        }
      }
      for (const link of options.relations ?? []) {
        const from = replacement.get(link.from),
          to = replacement.get(link.to);
        if (from && to)
          relations.push({
            kind: link.kind,
            from,
            to,
            ...(link.description !== undefined ? { description: link.description } : {})
          });
      }
    });
  }
  /**
   * Writes new notes (made by `create`, which pushes each one into `copies` as soon as it exists) together with the
   * Map.md edit as one transaction and one history step. A failure parks the notes in Unassigned (never deletes them).
   */
  private async writeNewBranches(
    before: MapDocument,
    target: MapNode | null,
    create: (
      copies: MapNode[],
      pairs: Array<{ from: string; to: string }>,
      relations: TopicRelation[]
    ) => Promise<void>,
    cross?: CrossCut
  ): Promise<MapNode[]> {
    const viewport = clone(before.viewport);
    const copies: MapNode[] = [],
      pairs: Array<{ from: string; to: string }> = [],
      newRelations: TopicRelation[] = [],
      repo = this.plugin.repo,
      parkFolder = repo.topicFolder(this.path, "Unassigned");
    let entry: TransactionEntry;
    try {
      await cross?.snapshot();
      await create(copies, pairs, newRelations);
      // Only the new copies are written, before the transaction; a failure parks them like any other.
      if (pairs.length) await repo.rewriteCopiedNoteLinks(pairs);
      const tx = cross ? cross.begin() : this.beginMapTransaction();
      for (const copy of copies) tx.create(copy.path, parkFolder, before.id);
      cross?.join(tx);
      entry = await tx
        .editMap(this.path, map => {
          map.viewport = clone(viewport);
          const found = target ? map.nodes.find(node => node.id === target.id) : null;
          if (target && !found) throw new Error(t("ui.outline_import_selected_missing"));
          map.nodes.push(...copies);
          if (found) {
            found.collapsed = false;
            map.nodes = arrangeNewBranch(
              map.nodes,
              found.id,
              new Set(copies.map(copy => copy.id)),
              this.cardHeightOf,
              undefined,
              layoutOf(map)
            );
          } else
            for (const top of copies.filter(copy => copy.parentId === null))
              map.nodes = arrangeNewTree(
                map.nodes,
                top.id,
                new Set([top.id, ...descendants(copies, top.id)]),
                this.cardHeightOf,
                layoutOf(map)
              );
          for (const link of newRelations) {
            if (!relationAllowed(map.topicRelations ?? [], link)) continue;
            setTopicRelations(map, [...(map.topicRelations ?? []), link]);
          }
        })
        .commit();
    } catch (error) {
      this.render();
      // A rollback that did not fail is complete in value; the source notes also get their exact bytes back. A failure
      // here loses nothing (the values are already back), so it is not reported as a failed rollback.
      if (cross && !isTransactionError(error, "rollback-failed")) await cross.restore().catch(() => {});
      // The copies are created outside the transaction: park them (never delete them) and rebuild.
      let parkFailure: { error: unknown } | undefined;
      try {
        let parkedAny = false;
        for (const copy of copies) {
          if (!this.app.vault.getAbstractFileByPath(copy.path)) continue;
          const parked = await repo.moveUnique(copy.path, parkFolder);
          parkedAny = true;
          await repo.setLifecycle(parked, before.id, "", "unassigned");
        }
        if (parkedAny) await this.plugin.rebuildDerivedData();
      } catch (parkError) {
        parkFailure = { error: parkError };
      }
      if (parkFailure || isTransactionError(error, "rollback-failed")) {
        const earlier: unknown[] = isTransactionError(error, "rollback-failed")
          ? ((error as Partial<AggregateError>).errors ?? [error])
          : [error];
        throw Object.assign(
          new AggregateError(
            parkFailure ? [...earlier, parkFailure.error] : earlier,
            t("error.batch_copy_rollback_failed")
          ),
          { kind: "rollback-failed" as const }
        );
      }
      throw error;
    }
    if (cross) await cross.finish(entry);
    else this.history.push(this.copyEntry(entry));
    this.multiSelected.clear();
    await this.refreshAfterSavedChange();
    return copies.filter(copy => copy.parentId === (target?.id ?? null));
  }
  // ---- Clipboard: copy and paste of branches inside one map (decisions #25, #29) -----------------------------------
  /** Listeners are on the document (a card without focus sends the event with `body` as target), one per window. */
  private unbindClipboard: (() => void) | null = null;
  private bindClipboard(): void {
    this.unbindClipboard?.();
    const doc: Document | undefined = this.contentEl.doc ?? this.contentEl.ownerDocument;
    if (!doc?.addEventListener) return;
    const copy = (event: Event): void => this.onClipboardEvent("copy", event as ClipboardEvent);
    const cut = (event: Event): void => this.onClipboardEvent("cut", event as ClipboardEvent);
    const paste = (event: Event): void => this.onClipboardEvent("paste", event as ClipboardEvent);
    doc.addEventListener("copy", copy);
    doc.addEventListener("cut", cut);
    doc.addEventListener("paste", paste);
    this.unbindClipboard = () => {
      doc.removeEventListener("copy", copy);
      doc.removeEventListener("cut", cut);
      doc.removeEventListener("paste", paste);
    };
  }
  private onClipboardEvent(kind: "copy" | "cut" | "paste", event: ClipboardEvent): void {
    if (this.closed || event.defaultPrevented) return;
    // Any copy or cut in this window, wherever it happens, drops a pending cut: the clipboard no longer holds it.
    if (kind !== "paste") {
      sessionFor(this.plugin).cancelCut();
      this.refreshCutMarks();
    }
    if (!this.map || !event.clipboardData) return;
    if (!inClipboardScope(event.target, this.contentEl)) return;
    if (kind === "paste") this.pasteFromClipboard(event);
    else this.copyToClipboard(event, kind);
  }
  /** True when branches cannot be changed here: integration mode, AIM, the built-in sample, or no saved map. */
  private clipboardReadOnly(): boolean {
    return this.builtIn || this.integrationMode || !!this.map?.aim || this.outlineImportTarget().map !== "editable";
  }
  private copyToClipboard(event: ClipboardEvent, mode: "copy" | "cut"): void {
    const map = this.map;
    const ids = this.multiSelected.size ? [...this.multiSelected] : this.selected ? [this.selected] : [];
    if (!map || !ids.length || !event.clipboardData) return;
    if (mode === "cut" && this.clipboardReadOnly()) {
      new Notice(t("ui.clipboard_cut_readonly"));
      return;
    }
    // Selected text (for example in a preview) is copied as text, not as a branch.
    const selection = this.contentEl.ownerDocument?.getSelection?.();
    if (selection && !selection.isCollapsed && selection.anchorNode && this.contentEl.contains(selection.anchorNode))
      return;
    const visited: string[] = [];
    const built = buildClipboardPayload({
      nodes: map.nodes,
      order: [...map.nodes].sort((a, b) => a.y - b.y || a.x - b.x).map(node => node.id),
      selectedIds: ids,
      noteOf: id => {
        visited.push(id);
        const note = this.notes.get(id);
        const node = map.nodes.find(item => item.id === id);
        return {
          title: note?.title ?? node?.path.replace(/^.*\//, "").replace(/\.md$/, "") ?? "",
          body: note?.detail ?? "",
          kind: note?.topicKind ?? "topic",
          ...(note?.hypothesisStrength !== undefined ? { strength: note.hypothesisStrength } : {})
        };
      },
      relations: map.topicRelations ?? [],
      clipId: crypto.randomUUID()
    });
    if (!built.ok || !visited.length) {
      new Notice(t("ui.clipboard_copy_failed"));
      return;
    }
    const serialized = serializeClipboard(built.payload);
    writeClipboardData(event.clipboardData, serialized, clipboardOutline(built.payload));
    event.preventDefault();
    sessionFor(this.plugin).record({
      clipId: built.payload.clipId,
      serialized,
      mode,
      sourceMapPath: this.path,
      sourceMapId: map.id,
      nodeIds: visited,
      notePaths: visited.map(id => map.nodes.find(node => node.id === id)?.path ?? "")
    });
    this.refreshCutMarks();
  }
  private pasteFromClipboard(event: ClipboardEvent): void {
    const { vam, text } = readClipboardData(event.clipboardData);
    // A clipboard that is not exactly what this plugin wrote means the cut was overtaken: its mark goes away.
    if (!sessionFor(this.plugin).match(vam)) {
      if (sessionFor(this.plugin).cancelCut()) this.refreshCutMarks();
    }
    // Without the private format: a picture file (with nothing selected) is a free image, else plain text is an outline.
    if (!vam) {
      if (this.pasteCanvasImages(event)) return;
      this.pasteText(event, text);
      return;
    }
    event.preventDefault();
    if (this.clipboardReadOnly()) {
      new Notice(t("ui.clipboard_paste_readonly"));
      return;
    }
    const parsed = parseClipboard(vam);
    if (!parsed.ok) {
      // A private payload that cannot be read falls back to the plain text beside it; with no usable text, say so.
      if (text.trim()) this.pasteText(event, text);
      else new Notice(t("ui.clipboard_paste_invalid"));
      return;
    }
    this.enqueue(() => this.pasteBranches(parsed.payload, vam));
  }
  /** Plain text pasted onto the map: indentation makes the levels. Empty text is left alone; a refusal says why. */
  private pasteText(event: ClipboardEvent, text: string): void {
    if (!text.trim()) return;
    event.preventDefault();
    if (this.clipboardReadOnly()) {
      new Notice(t("ui.clipboard_paste_readonly"));
      return;
    }
    const parsed = parseIndentedText(text);
    if (!parsed.ok) {
      new Notice(this.pasteTextRefusal(parsed.reason, parsed.line));
      return;
    }
    if (!parsed.nodes.length) return;
    const target = this.map?.nodes.find(node => node.id === this.selected) ?? null;
    // importOutlineIntoMap queues its own write, so it is not wrapped in enqueue.
    void this.importOutlineIntoMap(
      { nodes: parsed.nodes, source: null, shallowResearch: false },
      target ? { kind: "under", parentId: target.id } : { kind: "tree" }
    ).catch(error => new Notice(errorMessage(error)));
  }
  private pasteTextRefusal(reason: IndentedTextRejection, line?: number): string {
    const at = line ?? 0;
    switch (reason) {
      case "too-long":
        return t("ui.clipboard_text_too_long", PASTE_TEXT_MAX_CHARS);
      case "too-many-nodes":
        return t("ui.clipboard_text_too_many", at, OUTLINE_NODE_LIMIT);
      case "empty-title":
        return t("ui.clipboard_text_empty_title", at);
      case "title-too-long":
        return t("ui.clipboard_text_title_too_long", at, OUTLINE_TITLE_LIMIT);
      case "vam-note":
        return t("ui.clipboard_text_vam_note");
      case "outline":
        return line ? t("ui.clipboard_text_outline_line", line) : t("ui.clipboard_text_outline");
      default:
        return t("ui.clipboard_text_bad_title", at);
    }
  }
  /**
   * Pastes under the selected topic (or as new top-level trees). When the clipboard string is exactly what this plugin
   * wrote and its source is still this map, the source notes are duplicated (D2); otherwise only the payload's
   * whitelisted fields make new notes.
   */
  private async pasteBranches(payload: ClipboardPayload, raw: string): Promise<void> {
    const map = this.map;
    if (!map || this.clipboardReadOnly()) {
      new Notice(t("ui.clipboard_paste_readonly"));
      return;
    }
    const target = map.nodes.find(node => node.id === this.selected) ?? null;
    const record = sessionFor(this.plugin).match(raw);
    let tops: MapNode[] = [];
    const source = record && record.sourceMapPath === this.path && record.sourceMapId === map.id ? record : null;
    const nodeIds = source?.nodeIds ?? [];
    const ids = new Set(nodeIds);
    const byId = new Map(map.nodes.map(node => [node.id, node] as const));
    // The source must still be the same tree: every copied topic exists and keeps the parent the payload recorded.
    const intact =
      source !== null &&
      nodeIds.length === payload.nodes.length &&
      payload.nodes.every((clip, index) => {
        const node = byId.get(nodeIds[index]);
        if (!node) return false;
        if (clip.parent === null) return !node.parentId || !ids.has(node.parentId);
        return node.parentId === nodeIds[payload.nodes.findIndex(item => item.id === clip.parent)];
      });
    if (record?.mode === "cut" && source && !intact) {
      // The source changed after the cut: it is not moved, and the mark goes away; the payload is pasted as a copy.
      sessionFor(this.plugin).cancelCut();
      this.refreshCutMarks();
    }
    // A cut made in another map: this map gets copies, the originals park in the source map's Unassigned (D8).
    if (record?.mode === "cut" && !source && record.sourceMapPath !== this.path) {
      const accepted = await this.acceptCrossCut(payload, record);
      if (!accepted) return;
      tops = await this.copyFromOtherMap(
        accepted,
        target,
        payload,
        record.nodeIds,
        this.crossCutOf(payload, record, accepted.branch)
      );
      const landed = this.map?.nodes.find(node => node.id === tops[0]?.id);
      if (landed) {
        this.selected = landed.id;
        this.render();
        this.focusNode(landed);
      }
      return;
    }
    // A copy made in another map: its notes are duplicated into this one, the source map is only read (D2, D3).
    const cross =
      record?.mode === "copy" && !source && record.sourceMapPath !== this.path
        ? await this.crossSourceOf(payload, record)
        : null;
    if (cross && record) {
      tops = await this.copyFromOtherMap(cross, target, payload, record.nodeIds);
    } else if (source && intact) {
      const roots = payload.nodes
        .map((clip, index) => (clip.parent === null ? byId.get(nodeIds[index]) : undefined))
        .filter((node): node is MapNode => !!node);
      if (record?.mode === "cut") {
        const check = canPasteCut(
          map.nodes,
          roots.map(root => root.id),
          target?.id ?? null
        );
        if (!check.ok) {
          new Notice(t(check.reason === "into-own-branch" ? "ui.clipboard_cut_into_own" : "ui.clipboard_cut_missing"));
          return;
        }
        await this.moveBranches(roots, target);
        sessionFor(this.plugin).cancelCut();
        this.refreshCutMarks();
        const moved = this.map?.nodes.find(node => node.id === roots[0].id);
        if (moved) {
          this.selected = moved.id;
          this.render();
          this.focusNode(moved);
        }
        return;
      }
      const original = (clipId: string): string => nodeIds[payload.nodes.findIndex(item => item.id === clipId)];
      tops = await this.copyBranches(roots, target, {
        keepTitle: true,
        relations: payload.relations.map(link => ({
          kind: link.kind,
          from: original(link.from),
          to: original(link.to),
          ...(link.description !== undefined ? { description: link.description } : {})
        }))
      });
    } else {
      const plan = planPaste(payload);
      if (!plan.ok) {
        new Notice(t("ui.clipboard_paste_invalid"));
        return;
      }
      const repo = this.plugin.repo,
        settings = this.plugin.settings,
        before = clone(map),
        model = target
          ? inheritModel((await repo.readNote(target.path, map)).model, settings.cliModel)
          : settings.cliModel;
      tops = await this.writeNewBranches(before, target, async (copies, _pairs, relations) => {
        for (const item of plan.items) {
          const node = await repo.createNote(
            item.title,
            model,
            before,
            this.path,
            target || item.parent !== null ? "inherited" : "workspace",
            { topicKind: item.kind, detail: item.body }
          );
          node.parentId = item.parent === null ? (target?.id ?? null) : copies[item.parent].id;
          copies.push(node);
          if (item.kind === "hypothesis" && item.strength) await repo.writeHypothesisStrength(node.path, item.strength);
        }
        for (const link of plan.relations)
          relations.push({
            kind: link.kind,
            from: copies[link.from].id,
            to: copies[link.to].id,
            ...(link.description !== undefined ? { description: link.description } : {})
          });
      });
    }
    const placed = this.map?.nodes.find(node => node.id === tops[0]?.id);
    if (placed) {
      this.selected = placed.id;
      this.render();
      this.focusNode(placed);
    }
  }
  /** The recorded source of a copy made in another map, when that map still holds exactly those topics and notes; else null. */
  private async crossSourceOf(
    payload: ClipboardPayload,
    record: { sourceMapPath: string; sourceMapId: string; nodeIds: readonly string[]; notePaths: readonly string[] }
  ): Promise<{ branch: MapNode[]; roots: MapNode[] } | null> {
    try {
      const sourceMap = await this.plugin.repo.readMap(record.sourceMapPath);
      const found = resolveCrossSource(payload, record, sourceMap);
      if (!found || found.branch.some(node => !this.app.vault.getAbstractFileByPath(node.path))) return null;
      return found;
    } catch {
      return null;
    }
  }
  /**
   * Duplicates topics of another map under `target` (null = new top-level trees) as one transaction of this map. The
   * source notes are only read; links in the copies are rewritten from the source note's place by writeNewBranches.
   */
  private async copyFromOtherMap(
    source: { branch: MapNode[]; roots: MapNode[] },
    target: MapNode | null,
    payload: ClipboardPayload,
    nodeIds: readonly string[],
    cross?: CrossCut
  ): Promise<MapNode[]> {
    if (!this.map) return [];
    const before = clone(this.map);
    if (!this.mergeUnlocked(target ? [target.id] : [])) return [];
    const repo = this.plugin.repo,
      replacement = new Map<string, string>(),
      rootOf = new Map<string, MapNode>();
    return this.writeNewBranches(
      before,
      target,
      async (copies, pairs, relations) => {
        for (const original of source.branch) {
          const root = source.roots.includes(original) ? original : (rootOf.get(original.parentId!) ?? original);
          rootOf.set(original.id, root);
          const copy = await repo.duplicateNote(original.path, before, this.path, { keepTitle: true });
          replacement.set(original.id, copy.id);
          copy.parentId = source.roots.includes(original)
            ? (target?.id ?? null)
            : (replacement.get(original.parentId!) ?? target?.id ?? null);
          copy.x = (target ? target.x + 340 : 80) + (original.x - root.x);
          copy.y = (target ? target.y : 80) + source.roots.indexOf(root) * 220 + (original.y - root.y);
          copies.push(copy);
          pairs.push({ from: original.path, to: copy.path });
        }
        for (const link of payload.relations) {
          const from = replacement.get(nodeIds[payload.nodes.findIndex(item => item.id === link.from)]),
            to = replacement.get(nodeIds[payload.nodes.findIndex(item => item.id === link.to)]);
          if (from && to)
            relations.push({
              kind: link.kind,
              from,
              to,
              ...(link.description !== undefined ? { description: link.description } : {})
            });
        }
      },
      cross
    );
  }
  /**
   * A cut made in another map: decides, before anything is written, whether its branches can still be cut out of the
   * source map. Returns the branches found there, or null after saying why (the cut mark stays unless the source is
   * gone, so the paste can be retried).
   */
  private async acceptCrossCut(
    payload: ClipboardPayload,
    record: ClipRecord
  ): Promise<{ branch: MapNode[]; roots: MapNode[] } | null> {
    const session = sessionFor(this.plugin),
      from = record.sourceMapPath;
    const refuse = (key: TranslationKey, drop = false): null => {
      if (drop && session.cancelCut()) this.refreshCutMarks();
      new Notice(t(key));
      return null;
    };
    if (!this.app.vault.getAbstractFileByPath(from)) return refuse("ui.clipboard_cut_missing", true);
    // The source map may be open in another view: its pending save goes out first, and an open conflict window stops the cut.
    for (const view of this.plugin.views()) {
      if (view === this || view.path !== from) continue;
      if (view.conflictOpen) return refuse("ui.clipboard_cut_cross_busy");
      await view.flushForCrossMap();
    }
    let sourceMap: MapDocument;
    try {
      sourceMap = await this.plugin.repo.readMap(from);
    } catch {
      return refuse("ui.clipboard_cut_missing", true);
    }
    const found = resolveCrossSource(payload, record, sourceMap);
    const problem = cutSourceProblem(sourceMap, record, found);
    if (problem === "gone") return refuse("ui.clipboard_cut_missing", true);
    if (problem === "aim") return refuse("ui.clipboard_cut_cross_unsupported");
    if (problem === "changed" || !found) return refuse("ui.clipboard_cut_cross_changed");
    if (found.branch.some(node => this.plugin.running.has(node.path))) return refuse("ui.merge_locked");
    return found;
  }
  /** The source map's side of a cross-map cut (decision #28): re-checks it right before the writes, parks the originals. */
  private crossCutOf(payload: ClipboardPayload, record: ClipRecord, branch: MapNode[]): CrossCut {
    const plugin = this.plugin,
      repo = plugin.repo,
      from = record.sourceMapPath,
      into = this.path,
      id = crypto.randomUUID(),
      removed = new Set(branch.map(node => node.id)),
      texts = new Map<string, string>();
    const assertSource = (sourceMap: MapDocument): void => {
      const problem = cutSourceProblem(sourceMap, record, resolveCrossSource(payload, record, sourceMap));
      if (problem)
        throw new Error(
          t(
            problem === "aim"
              ? "ui.clipboard_cut_cross_unsupported"
              : problem === "gone"
                ? "ui.clipboard_cut_missing"
                : "ui.clipboard_cut_cross_changed"
          )
        );
    };
    return {
      snapshot: async () => {
        for (const node of branch) texts.set(node.path, await this.app.vault.read(repo.file(node.path)));
      },
      restore: async () => {
        for (const [path, text] of texts) {
          if (!this.app.vault.getAbstractFileByPath(path)) continue;
          // Putting a parked note back rewrites its `updated:` stamp and front matter order; anything else is left alone.
          // The check runs on the text `process` hands over, so an edit made after any earlier read is never overwritten.
          await this.app.vault.process(repo.file(path), current =>
            current !== text && sameApartFromStamps(current, text) ? text : current
          );
        }
      },
      begin: () => this.beginCrossTransaction(from, async () => assertSource(await repo.readMap(from))),
      join: tx => {
        const parkFolder = repo.topicFolder(from, "Unassigned");
        for (const node of branch) tx.park(node.path, parkFolder, record.sourceMapId, "unassigned");
        tx.editMap(from, map => {
          // The transaction hands over Map.md as it reads it at commit: a change made since the checks stops here.
          assertSource(map);
          map.nodes = map.nodes.filter(node => !removed.has(node.id));
          removeTopicRelationsFor(map, removed);
        });
      },
      finish: async entry => {
        ledgerFor(plugin).push({
          id,
          paths: [from, into],
          entry: { undo: () => entry.undo(), redo: () => entry.redo() }
        });
        this.history.push(this.crossMapEntry(id));
        if (sessionFor(plugin).cancelCut()) this.refreshCutMarks();
        try {
          this.adoptSavedMap(await repo.readMap(into));
        } catch {
          /* The saved change is reloaded by refreshAfterSavedChange. */
        }
      }
    };
  }
  /**
   * A transaction over two maps that holds no view: the entry outlives the views, so every view of a map is found
   * through the plugin when it is needed. `verify` runs on the source map after its open view settled any conflict and
   * before anything is written.
   */
  private beginCrossTransaction(sourcePath: string, verify: () => Promise<void>): Transaction {
    const plugin = this.plugin;
    return beginTransaction({
      repo: plugin.repo,
      rebuildDerivedData: () => plugin.rebuildDerivedData(),
      onApplied: () => {},
      checkConflict: async mapPath => {
        // The source map is judged first, so a cut that cannot go ahead never opens a conflict window in its view.
        if (mapPath === sourcePath) await verify();
        for (const view of plugin.views())
          if (view.path === mapPath && (await view.resolveMapConflict())) await view.persist();
      }
    });
  }
  /** Sends out what this view still has pending for its map (a pan or zoom not yet written). */
  private async flushForCrossMap(): Promise<void> {
    if (this.viewportTimer === null) return;
    window.clearTimeout(this.viewportTimer);
    this.viewportTimer = null;
    await this.persistViewport();
  }
  /** History proxy of a change that touched two maps: undo and redo go through the plugin's ledger, which runs each once. */
  private crossMapEntry(id: string): Action {
    return {
      label: t("ui.clipboard_cut_cross_history"),
      undo: () => this.runCrossMap(id, "undo"),
      redo: () => this.runCrossMap(id, "redo")
    };
  }
  private async runCrossMap(id: string, direction: "undo" | "redo"): Promise<void> {
    const result = await ledgerFor(this.plugin).run(id, direction);
    if (result.ran) {
      // The other map's view reloads when the write queue ends; this view adopts its own map now.
      if (this.path && !this.builtIn) this.adoptSavedMap(await this.plugin.repo.readMap(this.path));
      return;
    }
    if (result.reason === "failed" || result.reason === "broken") {
      if (result.error === undefined) throw new Error(t("ui.cross_map_undo_broken"));
      if (isTransactionError(result.error, "stale") || isTransactionError(result.error, "guard"))
        throw new Error(t("ui.cross_map_undo_refused"));
      // Thrown as it is: a failed rollback keeps its `rollback-failed` kind and its messages (errors cross realms in tests).
      throw result.error as Error;
    }
    // Another view already ran it (or it is gone): nothing to do, and this view's proxy goes away. `travel` has already
    // moved the proxy to the other stack; take it out of that one too, so it cannot be pressed again.
    if (result.reason === "wrong-state" || result.reason === "unknown") {
      const mark = this.history.mark();
      if (direction === "undo") {
        this.history.redo();
        this.history.discardSince(mark);
      } else {
        this.history.discardSince({ ...mark, length: mark.length - 1 });
      }
    }
  }
  /** After this view's history was cleared: puts back a proxy for each cross-map change of this map that is still applied. */
  private restoreCrossProxies(): void {
    if (!this.path || this.builtIn) return;
    for (const item of ledgerFor(this.plugin).entriesFor(this.path))
      if (item.status === "applied") this.history.push(this.crossMapEntry(item.id));
  }
  /** One history step for a copy: the commit's entry, with its own message when undo cannot be fully restored. */
  private copyEntry(entry: TransactionEntry): TransactionEntry {
    return {
      ...entry,
      undo: async () => {
        try {
          await entry.undo();
        } catch (error) {
          if (isTransactionError(error, "rollback-failed"))
            throw Object.assign(
              new AggregateError(
                (error as Partial<AggregateError>).errors ?? [error],
                t("error.copy_rollback_restore_failed")
              ),
              { kind: "rollback-failed" as const }
            );
          throw error;
        }
      }
    };
  }
  /** Builds the transaction file-moving methods share: Map.md of the open map is checked for outside edits first and adopted after each apply. */
  private beginMapTransaction(): Transaction {
    return beginTransaction({
      repo: this.plugin.repo,
      rebuildDerivedData: () => this.plugin.rebuildDerivedData(),
      onApplied: (mapPath, map) => {
        if (mapPath === this.path) this.adoptSavedMap(map);
      },
      checkConflict: async mapPath => {
        if (mapPath !== this.path) return;
        if (await this.resolveMapConflict()) await this.persist();
      }
    });
  }
  /** Takes `saved` (the map as now stored) as the open map, in place: callers and tests hold references to the open map. */
  private adoptSavedMap(saved: MapDocument): void {
    const next = clone(saved);
    if (!this.map) {
      this.map = next;
      return;
    }
    const viewport = this.map.viewport;
    const target = this.map as unknown as Record<string, unknown>;
    for (const key of Object.keys(target)) if (!(key in next)) delete target[key];
    for (const [key, value] of Object.entries(next)) {
      const current = target[key];
      // Arrays keep their identity too (the node list is held by cards and tests).
      if (Array.isArray(current) && Array.isArray(value)) current.splice(0, current.length, ...(value as unknown[]));
      else target[key] = value;
    }
    this.map.viewport = clone(viewport);
  }
  /** The change is already saved and in history; a failing reload must not look like the change failed. */
  private async refreshAfterSavedChange(): Promise<void> {
    try {
      await this.hydrate();
      this.render();
    } catch {
      this.render();
      new Notice(t("ui.change_saved_refresh_failed"));
    }
  }
  private async claimToCurrent(file: TFile): Promise<void> {
    if (!this.map) return;
    const id = crypto.randomUUID(),
      original = file.path;
    const entry = await this.beginMapTransaction()
      .unpark(original, this.plugin.repo.topicFolder(this.path, "Notes"), this.map.id, this.map.id)
      .editMap(this.path, (map, resolve) => {
        map.nodes.push({
          id,
          path: resolve(original),
          parentId: null,
          x: 80,
          y: Math.max(-100, ...map.nodes.map(item => item.y)) + 240,
          collapsed: false
        });
      })
      .commit();
    this.selected = id;
    this.history.push(entry);
    await this.refreshAfterSavedChange();
    const node = this.map?.nodes.find(item => item.id === id);
    if (node) this.focusNode(node);
  }
  private async relinkMissingNode(node: MapNode, file: TFile): Promise<void> {
    if (!this.map) return;
    const original = file.path;
    const entry = await this.beginMapTransaction()
      .unpark(original, this.plugin.repo.topicFolder(this.path, "Notes"), this.map.id, this.map.id)
      .editMap(this.path, (map, resolve) => {
        const replacement = map.nodes.find(item => item.id === node.id);
        if (!replacement) throw new Error(t("ui.the_node_to_relink_was_not_found"));
        rebaseMapNotePaths(map, moveNotePath(replacement.path, resolve(original)));
      })
      .commit();
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  private async parkFile(
    file: TFile,
    collection: "Unassigned" | "Archive",
    state: "unassigned" | "archived"
  ): Promise<void> {
    if (!this.map) return;
    const entry = await this.beginMapTransaction()
      .park(file.path, this.plugin.repo.topicFolder(this.path, collection), this.map.id, state)
      .commit();
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  private async transferToTopic(file: TFile, topic: TopicInfo): Promise<void> {
    const entry = await this.beginMapTransaction().transfer(file.path, topic, "unassigned").commit();
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  private async transferAndAdd(file: TFile, topic: TopicInfo): Promise<void> {
    const original = file.path;
    const entry = await this.beginMapTransaction()
      .transfer(original, topic, "add")
      .editMap(topic.mapPath, (map, resolve) => {
        map.nodes.push({
          id: crypto.randomUUID(),
          path: resolve(original),
          parentId: null,
          x: 80,
          y: Math.max(-100, ...map.nodes.map(item => item.y)) + 240,
          collapsed: false
        });
      })
      .commit();
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  private async noteChange(node: MapNode, patch: NotePatch): Promise<void> {
    const current = await this.plugin.repo.readNote(node.path, this.map ?? undefined),
      before: NotePatch = {};
    for (const key of Object.keys(patch) as (keyof Note)[]) (before as Record<string, unknown>)[key] = current[key];
    // A summary can rewrite the preview, so its undo restores the preview text and its bookkeeping too. The text is the
    // merged preview (callout plus any unmerged legacy User Notes), since the write folds that section into the callout.
    const followsSummary =
      patch.summary !== undefined && patch.preview === undefined && patch.previewSection === undefined;
    if (followsSummary) {
      before.previewSection = current.preview;
      before.previewInitialized = current.previewInitialized;
      before.previewAutoHash = current.previewAutoHash;
    }
    if (Object.keys(patch).every(key => current[key as keyof Note] === patch[key as keyof Note])) return;
    await this.plugin.repo.updateNote(node.path, patch);
    const written = followsSummary ? await this.plugin.repo.readNote(node.path, this.map ?? undefined) : null;
    if (patch.referencePaths !== undefined) {
      this.plugin.pendingSuggestions.delete(node.path);
      this.plugin.pendingResearchOptions.delete(node.path);
      if (this.plugin.pendingSuggestions instanceof PendingSuggestions) await this.plugin.pendingSuggestions.flush();
    }
    if (
      [
        "title",
        "summary",
        "prompt",
        "rules",
        "detail",
        "model",
        "reasoning",
        "researchMode",
        "sourcePaths",
        "referencePaths"
      ].some(key => key in patch)
    )
      this.plugin.activeTasks?.get(node.path)?.abort();
    this.history.push({
      undo: async () => {
        let restore = before;
        if (written) {
          // The preview is put back only while it is still exactly what this change wrote; a later edit of it stays.
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          if (latest.preview !== written.preview || latest.previewAutoHash !== written.previewAutoHash) {
            restore = { ...before };
            delete restore.previewSection;
            delete restore.previewInitialized;
            delete restore.previewAutoHash;
          }
        }
        await this.plugin.repo.updateNote(node.path, restore);
      },
      redo: () => this.plugin.repo.updateNote(node.path, patch)
    });
    this.notes.set(node.id, await this.plugin.repo.readNote(node.path, this.map ?? undefined));
    this.render();
  }
  /** What "the note is still as written" means for the background diagram step: every field a user or run can change. */
  private chartSnapshot(note: Note): string {
    return JSON.stringify([
      note.title,
      note.summary,
      note.detail,
      note.prompt,
      note.rules,
      note.visualReferences,
      note.newFindings,
      note.model,
      note.reasoning,
      note.researchMode,
      note.visualMode,
      note.status,
      note.sourcePaths,
      note.referencePaths,
      note.thinkingOrigin
    ]);
  }
  /**
   * Starts the diagram step in the background for a note that was just written and returns at once. The diagrams are
   * applied (as their own undoable entry) only when the note still equals what was written and no run is active on
   * it; otherwise they are dropped and the note stays as written.
   */
  private queueCharts(job: {
    path: string;
    saved: Note;
    context: TaskContext;
    detail: string;
    formatIssues?: AiResult["formatIssues"];
    model: string;
    language: ContentLanguage;
    template?: DetailTemplate;
  }): void {
    const path = job.path;
    const snapshot = this.chartSnapshot(job.saved);
    const map = this.map ?? undefined;
    this.plugin.addChartsAfterWrite({
      path,
      context: job.context,
      detail: job.detail,
      countIssues: job.formatIssues,
      model: job.model,
      apply: async charted => {
        if (this.plugin.running.has(path)) return false;
        const latest = await this.plugin.repo.readNote(path, map);
        if (this.chartSnapshot(latest) !== snapshot) return false;
        await this.plugin.repo.updateNote(
          path,
          { detail: canonicalDetail(charted, noteLanguageOf(job.language), job.template) },
          { detailTemplate: job.template }
        );
        const after = await this.plugin.repo.readNote(path, map);
        if (!this.closed) this.recordNoteWrite(path, latest, after, ["detail"], t("ui.add_charts_history"));
        for (const view of this.plugin.views()) if (view !== this) view.history.clear();
        return true;
      }
    });
  }
  private recordNoteWrite(path: string, before: Note, after: Note, fields: (keyof NotePatch)[], label: string): void {
    const oldValues: NotePatch = {},
      newValues: NotePatch = {};
    for (const field of fields) {
      (oldValues as Record<string, unknown>)[field] = before[field];
      (newValues as Record<string, unknown>)[field] = after[field];
    }
    const restore = async (expected: NotePatch, replacement: NotePatch): Promise<void> => {
      const latest = await this.plugin.repo.readNote(path);
      for (const field of fields)
        if (JSON.stringify(latest[field]) !== JSON.stringify(expected[field]))
          throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      await this.plugin.repo.updateNote(path, replacement);
    };
    this.history.push({ label, undo: () => restore(newValues, oldValues), redo: () => restore(oldValues, newValues) });
    this.updateHistoryButtons();
  }
  private openDetails(node: MapNode): void {
    void this.plugin
      .openDetails(this.plugin.repo.file(node.path))
      .catch(error => new Notice(error instanceof Error ? error.message : String(error)));
  }
  private async travel(redo: boolean): Promise<void> {
    // Undo and redo replace Map.md like any change: an outside edit goes through the same conflict window first.
    if (
      this.map &&
      this.path &&
      !this.builtIn &&
      (redo ? this.history.canRedo : this.history.canUndo) &&
      (await this.resolveMapConflict())
    ) {
      await this.persist();
      await this.hydrate();
      this.render();
      return;
    }
    const action = redo ? this.history.redo() : this.history.undo();
    if (!action) return;
    try {
      await (redo ? action.redo() : action.undo());
      await this.hydrate();
      this.render();
    } catch (error) {
      if (redo) this.history.undo();
      else this.history.redo();
      throw error;
    }
  }
  private updateHistoryButtons(): void {
    const undo = this.contentEl?.querySelector<HTMLButtonElement>("[data-history=undo]"),
      redo = this.contentEl?.querySelector<HTMLButtonElement>("[data-history=redo]");
    const label = (button: HTMLButtonElement, text: string): void => {
      if (button.dataset.icon) button.setAttr("aria-label", text);
      else button.setText(text);
    };
    if (undo) {
      undo.disabled = !this.history.canUndo;
      label(undo, this.history.undoEntry?.label ? `${t("ui.undo")}: ${this.history.undoEntry.label}` : t("ui.undo"));
    }
    if (redo) {
      redo.disabled = !this.history.canRedo;
      label(redo, this.history.redoEntry?.label ? `${t("ui.redo")}: ${this.history.redoEntry.label}` : t("ui.redo"));
    }
  }
  async synchronize(): Promise<void> {
    if (this.builtIn) return;
    // A batch of chat writes reads the map back once, when it is done.
    if (this.syncHold > 0) {
      this.syncPending = true;
      return;
    }
    if (!this.path || !this.map || this.closed) return;
    if (!(this.app.vault.getAbstractFileByPath(this.path) instanceof TFile)) {
      this.map = null;
      this.path = "";
      this.history.clear();
      this.render();
      return;
    }
    const disk = await this.plugin.repo.readMap(this.path);
    const structureChanged =
      JSON.stringify({ ...disk, viewport: null }) !== JSON.stringify({ ...this.map, viewport: null });
    if (structureChanged) {
      disk.viewport = this.map.viewport;
      this.map = disk;
      this.history.clear();
      this.restoreCrossProxies();
    }
    const before = JSON.stringify(Array.from(this.notes));
    await this.hydrate();
    if (structureChanged || before !== JSON.stringify(Array.from(this.notes))) {
      // The chat field is a text field too, but it is where the user waits for the map to change: only an IME
      // composition in it counts as editing (same rule as changed()).
      const editing = this.typingInField();
      if ((!editing || structureChanged) && !this.dragging) this.render();
      else {
        // Cards are refreshed without redrawing the edges each time (a redraw reads every card's layout); once at the end.
        for (const node of this.map.nodes) this.refreshCard(node, false);
        this.drawEdges();
      }
    }
  }
  /** The header's export button (AIM, the built-in sample and integration mode included, decision D11). */
  private addExportButton(parent: HTMLElement): HTMLButtonElement {
    return this.iconButton(parent, "download", t("ui.export_map"), event => this.openExportMenu(event));
  }
  private openExportMenu(event: MouseEvent): void {
    const menu = new Menu();
    const add = (title: string, icon: string, format: "png" | "svg" | "md", target: "vault" | "download"): void => {
      menu.addItem(item =>
        item
          .setTitle(title)
          .setIcon(icon)
          .onClick(() => void this.exportMap(format, target))
      );
    };
    add(t("ui.export_png_vault"), "image-down", "png", "vault");
    add(t("ui.export_png_download"), "download", "png", "download");
    add(t("ui.export_svg_vault"), "image-down", "svg", "vault");
    add(t("ui.export_svg_download"), "download", "svg", "download");
    add(t("ui.export_md_vault"), "file-down", "md", "vault");
    add(t("ui.export_md_download"), "download", "md", "download");
    menu.showAtMouseEvent(event);
  }
  /** The cover image file of a topic, resolved from the metadata cache exactly as the card resolves it. */
  private exportCoverPath(notePath: string): string | null {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) return null;
    const cover = resolveCover(this.app.metadataCache.getFileCache(file), link =>
      this.app.metadataCache.getFirstLinkpathDest(link, notePath)
    );
    return cover && "path" in cover ? cover.path : null;
  }
  /**
   * The map as the screen shows it (decision D9): card rectangles and edge paths (the fishbone spine included) are
   * read from the drawn DOM, so every layout is followed without a second layout engine; colours come from computed
   * styles; covers and free pictures are read with `readBinary` and embedded as data URIs. `isCurrent` is checked
   * after every await. Returns null when the view moved on, `{ empty }` for nothing to draw, `{ refuse }` when the
   * pictures alone are over the limit (read no further).
   */
  private async collectExportScene(
    isCurrent: () => boolean
  ): Promise<{ scene: MapScene; refuse?: undefined } | { scene?: undefined; refuse: "embedded" | "empty" } | null> {
    const map = this.map;
    if (!map) return null;
    const win = window;
    const computed = (el: Element, pseudo?: string): CSSStyleDeclaration => win.getComputedStyle(el, pseudo);
    const colorOf = (value: unknown): string | undefined => normalizeCssColor(value) || undefined;
    let embedded = 0;
    const loaded = new Map<string, string | null>();
    const imageHref = async (path: string): Promise<string | null | false> => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) return null;
      if (!loaded.has(path)) {
        const data = await this.app.vault.readBinary(file);
        const mime = sniffImage(data);
        loaded.set(path, mime ? toDataUri(mime, data) : null);
        sizes.set(path, mime ? data.byteLength : 0);
      }
      embedded += sizes.get(path) ?? 0;
      return embedded > EXPORT_MAX_EMBEDDED_BYTES ? false : (loaded.get(path) ?? null);
    };
    const sizes = new Map<string, number>();
    const cards: SceneCard[] = [];
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const grow = (x: number, y: number, w: number, h: number): void => {
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x + w);
      bounds.maxY = Math.max(bounds.maxY, y + h);
    };
    for (const [id, card] of this.cardEls) {
      const node = map.nodes.find(item => item.id === id);
      if (!node) continue;
      const box = boxOf(card);
      grow(box.x, box.y, box.width, box.height);
      const style = computed(card);
      const titleEl = card.querySelector<HTMLElement>(".vam-card-title");
      const title = (titleEl?.textContent ?? this.notes.get(id)?.title ?? "").trim();
      const item: SceneCard = {
        x: box.x,
        y: box.y,
        w: box.width,
        h: box.height,
        title: wrapText(title, box.width - 28),
        fill: colorOf(style.backgroundColor),
        stroke: colorOf(style.borderTopColor),
        textColor: colorOf(titleEl ? computed(titleEl).color : undefined),
        accent: card.dataset.topicColor ? colorOf(computed(card, "::before").backgroundColor) : undefined
      };
      const frame = card.querySelector<HTMLElement>(".vam-card-cover");
      const coverPath = frame ? this.exportCoverPath(node.path) : null;
      if (frame && coverPath) {
        const href = await imageHref(coverPath);
        if (!isCurrent()) return null;
        if (href === false) return { refuse: "embedded" };
        if (href)
          item.cover = {
            x: box.x + frame.offsetLeft,
            y: box.y + frame.offsetTop,
            w: frame.offsetWidth,
            h: frame.offsetHeight,
            href,
            fit: "cover"
          };
      }
      cards.push(item);
    }
    const images: SceneImage[] = [];
    for (const item of map.canvasItems ?? []) {
      if (item.kind !== "image") continue;
      const image = item as ImageItem;
      const href = await imageHref(image.path);
      if (!isCurrent()) return null;
      if (href === false) return { refuse: "embedded" };
      if (!href) continue;
      grow(image.x, image.y, image.w, image.h);
      images.push({ x: image.x, y: image.y, w: image.w, h: image.h, href, fit: "fill" });
    }
    // Frames as drawn on screen: measured from the same cards, so they follow the layout; a frame with no card is left out.
    const boundaries: SceneBoundary[] = [];
    for (const item of map.canvasItems ?? []) {
      if (item.kind !== "boundary") continue;
      const frame = item as BoundaryItem;
      const box = boundaryBounds(
        frame.members,
        id => {
          const card = this.cardEls.get(id);
          if (!card) return null;
          const b = boxOf(card);
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        },
        BOUNDARY_PAD
      );
      if (!box) continue;
      grow(box.x, box.y, box.w, box.h);
      boundaries.push({
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        ...(frame.label ? { label: frame.label } : {}),
        stroke: colorOf(computed(this.viewportEl ?? this.contentEl).getPropertyValue("--text-muted"))
      });
    }
    const edges: SceneEdge[] = [];
    for (const el of Array.from(this.edgesEl?.children ?? [])) {
      if (el.tagName?.toLowerCase() !== "path") continue;
      const d = el.getAttribute("d");
      const style = computed(el);
      const stroke = colorOf(style.stroke);
      if (!d || !stroke || stroke === "none" || style.display === "none") continue;
      edges.push({ d, stroke });
      try {
        const bbox = (el as unknown as SVGGraphicsElement).getBBox?.();
        if (bbox) grow(bbox.x, bbox.y, bbox.width, bbox.height);
      } catch {
        // A path that cannot be measured is still drawn; it only does not widen the picture.
      }
    }
    if (!cards.length && !images.length) return { refuse: "empty" };
    const margin = 24;
    const root = computed(this.viewportEl ?? this.contentEl);
    const variable = (name: string): string | undefined => colorOf(root.getPropertyValue(name));
    const scene: MapScene = {
      x: bounds.minX - margin,
      y: bounds.minY - margin,
      width: bounds.maxX - bounds.minX + margin * 2,
      height: bounds.maxY - bounds.minY + margin * 2,
      title: map.title,
      theme: {
        background: variable("--background-primary"),
        text: variable("--text-normal"),
        stroke: variable("--background-modifier-border"),
        card: variable("--background-primary")
      },
      boundaries,
      edges,
      cards,
      images
    };
    return { scene };
  }
  private async pngBlob(svg: string, width: number, height: number, scale: number): Promise<Blob> {
    return svgToPngBlob(svg, width, height, scale, browserPngEnv(window.URL));
  }
  /** A download through a blob URL; the URL is released shortly after the click. */
  private downloadBlob(blob: Blob, name: string): void {
    const url = window.URL.createObjectURL(blob);
    const link = this.contentEl.createEl("a", { cls: "vam-sr-only", attr: { href: url, download: name } });
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(url), 1000);
  }
  /**
   * Exports the map as PNG, SVG or a Markdown outline, saved next to the other attachments of Map.md or downloaded.
   * An export is not a map edit: no transaction, no undo step. A result that is ready after the view closed or moved
   * to another map is thrown away (nothing written, nothing said).
   */
  private async exportMap(format: "png" | "svg" | "md", target: "vault" | "download"): Promise<void> {
    const map = this.map;
    if (!map) return;
    const mapPath = this.path,
      epoch = this.mapOpenEpoch,
      isCurrent = (): boolean => !this.closed && this.path === mapPath && this.mapOpenEpoch === epoch && !!this.map;
    try {
      let blob: Blob;
      if (format === "md") {
        const outline = mapOutline(map.nodes, id => this.notes.get(id)?.title ?? "");
        blob = new Blob([`${outline}\n`], { type: "text/markdown;charset=utf-8" });
      } else {
        const got = await this.collectExportScene(isCurrent);
        if (!got || !isCurrent()) return;
        if (got.refuse) {
          new Notice(t(got.refuse === "empty" ? "ui.export_empty" : "ui.export_refused_embedded"));
          return;
        }
        const limit = exportLimits(got.scene);
        if (limit.action === "refuse") {
          new Notice(
            t(
              limit.reason === "embedded"
                ? "ui.export_refused_embedded"
                : limit.reason === "pixels"
                  ? "ui.export_refused_pixels"
                  : "ui.export_empty"
            )
          );
          return;
        }
        const svg = buildMapSvg(got.scene);
        if (format === "svg") blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
        else {
          const { width, height } = got.scene;
          let scale = 1;
          if (limit.action === "scaleDown") {
            scale = limit.scale;
            new Notice(t("ui.export_scaled", String(EXPORT_MAX_EDGE)));
          } else if (Math.max(width, height) * 2 <= EXPORT_MAX_EDGE && width * height * 4 <= EXPORT_MAX_PIXELS)
            scale = 2;
          blob = await this.pngBlob(svg, width, height, scale);
          if (!isCurrent()) return;
        }
      }
      const name = `${exportFileStem(map.title)}.${format}`;
      if (target === "download") {
        this.downloadBlob(blob, name);
        new Notice(t("ui.export_downloaded", name));
        return;
      }
      const data = await blob.arrayBuffer();
      const destination = await this.app.fileManager.getAvailablePathForAttachment(name, mapPath);
      // Last check before anything is written.
      if (!isCurrent()) return;
      await this.app.vault.createBinary(destination, data);
      new Notice(t("ui.export_saved", destination));
    } catch (error) {
      if (isCurrent()) new Notice(t("ui.export_failed", errorMessage(error)));
    }
  }
  private openMapActions(): void {
    const choices: { label: string; description?: string; buttonLabel?: string; action: () => void }[] = [];
    if (this.map) {
      choices.push({
        label: t("ui.rename_current_mind_map"),
        description: t("ui.update_the_topic_folder_and_mind_map_name_together"),
        action: () => this.renameCurrentMap()
      });
    }
    if (this.map && !this.builtIn && !this.map.aim)
      choices.push({
        label: t("ui.organize"),
        description: t("ui.manage_notes_that_are_currently_outside_the_mind_map"),
        action: () => this.enqueue(() => this.openOrganizer())
      });
    // One note style (content template + writing tone) for regular maps; templates do not apply to AIM maps.
    if (this.map && !this.builtIn && !this.map.aim)
      choices.push({
        label: t("ui.note_style_map_default"),
        description: t("ui.note_style_map_default_desc"),
        action: () => this.chooseMapStyle()
      });
    // Writing tone applies to the notes AI writes; AIM maps use it for their research and final report.
    if (this.map && !this.builtIn && this.map.aim)
      choices.push({
        label: t("ui.tone_map_default"),
        description: t("ui.tone_map_default_desc"),
        action: () => this.chooseMapTone()
      });
    choices.push({
      label: t("ui.repair_missing_mind_map"),
      description: t("ui.rebuild_a_missing_map_from_existing_topic_notes"),
      action: () => this.enqueue(() => this.repairMissingTopic())
    });
    if (this.map)
      choices.push({
        label: t("ui.delete_current_mind_map"),
        description: t("ui.remove_only_the_map_file_keep_all_topic_notes_undo_is_availa"),
        buttonLabel: t("ui.review"),
        action: () => this.deleteCurrentMap()
      });
    new ChoiceModal(this.app, t("ui.more_mind_map_actions"), t("ui.additional_map_management_actions"), choices).open();
  }
  /** The map's default note style: both stored values (template and tone) are set or cleared together. */
  private chooseMapStyle(): void {
    const apply = (templateId: string | undefined, toneId: string | undefined): void =>
      this.enqueue(() =>
        this.mapChange(map => {
          if (templateId) map.detailTemplateId = templateId;
          else delete map.detailTemplateId;
          if (toneId) map.toneId = toneId;
          else delete map.toneId;
        }, false)
      );
    const templateId = this.map?.detailTemplateId;
    const toneId = this.map?.toneId;
    const unset = !templateId && !toneId;
    const matched = unset ? undefined : matchPreset(templateId, toneId);
    const current = { description: t("ui.detail_template_current") };
    new ChoiceModal(this.app, t("ui.note_style_map_default"), t("ui.note_style_map_default_desc"), [
      {
        label: t("ui.note_style_use_default_0", this.defaultStyleLabel()),
        ...(unset ? current : {}),
        action: () => apply(undefined, undefined)
      },
      ...NOTE_STYLE_PRESETS.map(preset => ({
        label: t(preset.name),
        ...(matched?.id === preset.id ? current : {}),
        action: () => apply(preset.templateId, preset.toneId)
      })),
      {
        label: t("ui.note_style_custom"),
        description: unset || matched ? t("ui.note_style_custom_choose") : current.description,
        action: () =>
          new ChoiceModal(this.app, t("ui.note_style_custom"), t("ui.note_style_custom_choose"), [
            {
              label: t("ui.detail_template_map_default"),
              description: t("ui.detail_template_map_default_desc"),
              action: () => this.chooseMapTemplate()
            },
            {
              label: t("ui.tone_map_default"),
              description: t("ui.tone_map_default_desc"),
              action: () => this.chooseMapTone()
            }
          ]).open()
      }
    ]).open();
  }
  private chooseMapTone(): void {
    const apply = (id: string | undefined): void =>
      this.enqueue(() =>
        this.mapChange(map => {
          if (id) map.toneId = id;
          else delete map.toneId;
        }, false)
      );
    const current = this.map?.toneId;
    const mark = (id: string | undefined) => (id === current ? { description: t("ui.detail_template_current") } : {});
    new ChoiceModal(this.app, t("ui.tone_map_default"), t("ui.tone_map_default_desc"), [
      { label: t("ui.tone_use_default"), ...mark(undefined), action: () => apply(undefined) },
      ...this.toneChoices().map(({ id, name }) => ({ label: name, ...mark(id), action: () => apply(id) }))
    ]).open();
  }
  private chooseMapTemplate(): void {
    const apply = (id: string | undefined): void =>
      this.enqueue(() =>
        this.mapChange(map => {
          if (id) map.detailTemplateId = id;
          else delete map.detailTemplateId;
        }, false)
      );
    const current = this.map?.detailTemplateId;
    const mark = (id: string | undefined) => (id === current ? { description: t("ui.detail_template_current") } : {});
    new ChoiceModal(this.app, t("ui.detail_template_map_default"), t("ui.detail_template_map_default_desc"), [
      { label: t("ui.detail_template_use_workspace"), ...mark(undefined), action: () => apply(undefined) },
      ...this.templateChoices().map(({ id, name }) => ({ label: name, ...mark(id), action: () => apply(id) }))
    ]).open();
  }
  private aimActiveForPath(path: string): boolean {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).some(leaf => {
      const view = leaf.view;
      if (!(view instanceof VisualAgentMapView) || view.path !== path || !view.map?.aim) return false;
      return (
        view.aimBusy ||
        view.map.aim.runs.some(run => {
          const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
          return attempt?.status === "running" || attempt?.status === "saving";
        })
      );
    });
  }
  private renameCurrentMap(): void {
    if (!this.map) return;
    if (this.aimActiveForPath(this.path)) {
      new Notice(t("ui.aim_research_already_running"));
      return;
    }
    new NameModal(this.app, t("ui.rename_mind_map"), this.map.title, title =>
      this.enqueue(async () => {
        if (!this.map) return;
        if (this.aimActiveForPath(this.path)) {
          new Notice(t("ui.aim_research_already_running"));
          return;
        }
        if (!isManagedMapPath(this.plugin.settings, this.path)) {
          new Notice(t("ui.legacy_map_view_only"));
          return;
        }
        const before = clone(this.map),
          beforeRoot = this.plugin.repo.topicRoot(this.path);
        this.path = await this.plugin.repo.renameTopic(this.path, title);
        this.map = await this.plugin.repo.readMap(this.path);
        const after = clone(this.map),
          afterRoot = this.plugin.repo.topicRoot(this.path);
        const restore = async (map: MapDocument, root: string): Promise<void> => {
          this.path = await this.plugin.repo.renameTopic(this.path, map.title, root);
          this.map = clone(map);
          await this.plugin.repo.saveMap(this.path, this.map);
          await this.plugin.rebuildDerivedData();
          this.render();
        };
        this.history.push({ undo: () => restore(before, beforeRoot), redo: () => restore(after, afterRoot) });
        this.render();
        this.app.workspace.requestSaveLayout();
      })
    ).open();
  }
  private deleteCurrentMap(): void {
    if (!this.map) return;
    new ChoiceModal(
      this.app,
      t("ui.delete_mind_map"),
      t("ui.move_only_the_map_file_to_the_vault_trash_keep_all_notes_you"),
      [
        {
          label: t("ui.delete_0", this.map.title),
          description: t("ui.topic_notes_will_be_kept"),
          buttonLabel: t("ui.move_to_trash"),
          warning: true,
          action: () =>
            this.enqueue(async () => {
              if (!this.map) return;
              if (this.viewportTimer !== null) {
                window.clearTimeout(this.viewportTimer);
                this.viewportTimer = null;
                await this.persistViewport();
              }
              const path = this.path,
                file = this.plugin.repo.file(path),
                content = await this.app.vault.read(file),
                map = clone(this.map);
              this.deletedMap = { path, content, map, deleted: true };
              try {
                await this.app.fileManager.trashFile(file);
              } catch (error) {
                this.deletedMap = null;
                throw error;
              }
              this.map = null;
              this.path = "";
              await this.plugin.rebuildDerivedData();
              const deleteAction: Action = {
                label: t("ui.delete_mind_map"),
                undo: async () => {
                  await this.restoreDeletedMap();
                },
                redo: async () => {
                  await this.deleteRestoredMap();
                }
              };
              this.deletedMap.deleteAction = deleteAction;
              this.history.push(deleteAction);
              this.render();
            })
        }
      ]
    ).open();
  }
  private async restoreDeletedMap(): Promise<void> {
    const deleted = this.deletedMap;
    if (!deleted?.deleted) return;
    if (this.app.vault.getAbstractFileByPath(deleted.path)) throw new Error(t("ui.restore_path_occupied"));
    await this.app.vault.create(deleted.path, deleted.content);
    deleted.deleted = false;
    this.builtIn = false;
    this.path = deleted.path;
    this.map = clone(deleted.map);
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    this.render();
  }
  private async deleteRestoredMap(): Promise<void> {
    const deleted = this.deletedMap;
    if (!deleted || deleted.deleted) return;
    const file = this.app.vault.getAbstractFileByPath(deleted.path);
    if (!(file instanceof TFile) || (await this.app.vault.read(file)) !== deleted.content)
      throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    await this.app.fileManager.trashFile(file);
    deleted.deleted = true;
    this.path = "";
    this.map = null;
    await this.plugin.rebuildDerivedData();
    this.render();
  }
  private async restoreDeletedMapFromUi(): Promise<void> {
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persistViewport();
    }
    if (this.history.undoEntry === this.deletedMap?.deleteAction) await this.travel(false);
    else {
      await this.restoreDeletedMap();
      this.history.clear();
      this.history.push({
        label: t("ui.restore_deleted_map"),
        undo: () => this.deleteRestoredMap(),
        redo: () => this.restoreDeletedMap()
      });
      this.updateHistoryButtons();
    }
  }
  private async openOrganizer(): Promise<void> {
    if (!this.map) return;
    const [unassigned, archived] = await Promise.all([
      this.plugin.repo.collectionFiles(this.path, "Unassigned"),
      this.plugin.repo.collectionFiles(this.path, "Archive")
    ]);
    new ChoiceModal(this.app, t("ui.organize_notes"), t("ui.manage_notes_that_are_currently_outside_the_mind_map"), [
      {
        label: t("ui.unassigned_0", unassigned.length),
        description: t("ui.add_to_the_current_map_archive_or_move_to_another_topic"),
        action: () => this.openUnassigned(unassigned)
      },
      {
        label: t("ui.archived_0", archived.length),
        description: t("ui.view_archived_notes_or_move_them_back_to_unassigned"),
        action: () => this.openArchive(archived)
      }
    ]).open();
  }
  private openUnassigned(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("ui.unassigned_notes"), files, [
      { label: t("ui.add_to_mind_map"), run: file => this.enqueue(() => this.claimToCurrent(file)) },
      { label: t("ui.archive"), run: file => this.enqueue(() => this.parkFile(file, "Archive", "archived")) },
      {
        label: t("ui.move_to_another_topic"),
        run: file =>
          this.enqueue(async () => {
            const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id);
            new TopicPickerModal(this.app, t("ui.move_to_another_topic"), topics, topic =>
              this.enqueue(() => this.transferToTopic(file, topic))
            ).open();
          })
      },
      {
        label: t("ui.move_and_add_to_another_topic"),
        run: file =>
          this.enqueue(async () => {
            const topics = (await this.plugin.repo.topics()).filter(topic => topic.id !== this.map?.id);
            new TopicPickerModal(this.app, t("ui.move_and_add_to_another_mind_map"), topics, topic =>
              this.enqueue(() => this.transferAndAdd(file, topic))
            ).open();
          })
      }
    ]).open();
  }
  private openArchive(files: TFile[]): void {
    new NoteCollectionModal(this.app, t("ui.archived_notes"), files, [
      { label: t("ui.unarchive"), run: file => this.enqueue(() => this.parkFile(file, "Unassigned", "unassigned")) }
    ]).open();
  }
  private render(): void {
    // A batch of chat writes repaints once, when it is done.
    if (this.renderHold > 0 && !this.closed) {
      this.renderPending = true;
      return;
    }
    this.paint();
  }
  private paint(): void {
    // Repainting would replace the dragged card and drop its pointer capture, so wait for the drop (a closed view still ends the drag below).
    if (this.dragging && !this.closed) {
      if (!this.dragStale()) {
        this.renderAfterDrag = true;
        return;
      }
      // The map the drag started on is gone (another map opened, or it was deleted): end the drag and repaint now.
      this.dragCleanup?.();
      this.renderAfterDrag = false;
    }
    this.paintCount++;
    this.emptyMapEl = null;
    this.aimProgressEls.clear();
    // The dragged card is about to be replaced, so its pointer events would never arrive and the drag would stay "on".
    this.dragCleanup?.();
    if (this.closed) return;
    this.plugin.syncOutline(this.builtIn ? null : this.map, this.notes, this.builtIn, this);
    if (this.hoverTimer !== null) {
      window.clearTimeout(this.hoverTimer);
      this.hoverTimer = null;
    }
    this.hoverCard?.remove();
    this.hoverCard = null;
    const title = this.getDisplayText();
    if (title !== this.headerTitle) {
      this.headerTitle = title;
      window.setTimeout(() => {
        if (!this.closed) void this.leaf.setViewState({ type: VIEW_TYPE, state: this.getState() });
      }, 0);
    }
    const focusedCard = activeDocument.activeElement?.closest<HTMLElement>(".vam-node");
    if (focusedCard && this.contentEl.contains(focusedCard)) {
      if (activeDocument.activeElement?.classList.contains("vam-card-resize"))
        this.focusResizeNodeId ??= focusedCard.dataset.nodeId ?? null;
      else this.focusNodeId ??= focusedCard.dataset.nodeId ?? null;
    }
    const restoreRelevanceFocus = this.keepRelevanceBarFocus();
    const restoreChatFocus = this.detachMapChat();
    const restoreSearch = this.holdMapSearch();
    // The repaint removes the focused panel field first; its late focusout must not close the panel that is redrawn below.
    this.relevancePanelGen++;
    this.relevancePanelCleanup?.();
    this.relevancePanelCleanup = null;
    this.relevancePanelEl = null;
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv("vam-toolbar");
    const switcher = toolbar.createEl("button", { cls: "vam-map-switcher" });
    switcher.setAttr("aria-label", t("ui.switch_mind_map"));
    switcher.createSpan({ text: this.map?.title ?? "Visual Agent Map", cls: "vam-map-title", attr: { dir: "auto" } });
    setIcon(switcher.createSpan("vam-map-switcher-icon"), "chevrons-up-down");
    switcher.addEventListener("click", () => this.openMapSwitcher());
    if (this.builtIn) toolbar.createSpan({ cls: "vam-readonly-badge", text: t("ui.official_sample_read_only") });
    if (this.map && !this.builtIn && !this.map.aim && this.map.nodes.length) this.renderResearchProgress(toolbar);
    const headerActions = toolbar.createDiv("vam-toolbar-actions");
    if (this.builtIn) {
      // While the tour is open, a second way to start it only competes with Next.
      if (!this.showSampleTour)
        this.button(headerActions, t("ui.show_tour_again"), () => {
          this.showSampleTour = true;
          this.render();
        });
      if (this.map) this.addExportButton(headerActions);
    } else if (this.map) {
      const newMap = headerActions.createEl("button", { cls: "vam-new-map" });
      newMap.createSpan({ text: t("ui.new_map") });
      setIcon(newMap.createSpan("vam-new-map-icon"), "chevron-down");
      newMap.addEventListener("click", event => {
        event.stopPropagation();
        this.openNewMapMenu(event);
      });
      this.iconButton(headerActions, "list-tree", t("ui.open_topic_outline"), () => {
        void this.plugin.activateOutline(this).catch(error => new Notice(String(error)));
      });
      const undo = this.iconButton(headerActions, "undo-2", t("ui.undo"), () => this.enqueue(() => this.travel(false)));
      undo.disabled = !this.history.canUndo;
      undo.dataset.history = "undo";
      const redo = this.iconButton(headerActions, "redo-2", t("ui.redo"), () => this.enqueue(() => this.travel(true)));
      redo.disabled = !this.history.canRedo;
      redo.dataset.history = "redo";
      this.updateHistoryButtons();
      if (!this.map.aim)
        this.iconButton(headerActions, "share-2", t("share.button"), () => this.plugin.openShare(this));
      this.addExportButton(headerActions);
      this.iconButton(headerActions, "more-vertical", t("ui.more_mind_map_actions"), () => this.openMapActions());
    }
    const selectedNode = this.map?.nodes.find(node => node.id === this.selected);
    if (!this.builtIn && this.map?.aim) {
      const statusbar = this.contentEl.createDiv(`vam-aim-statusbar${this.aimBusy ? " is-active" : ""}`);
      statusbar.setAttr("aria-live", "polite");
      const data = this.map.aim;
      const questions = this.map.nodes.filter(node => node.aimKind === "question");
      const pendingQuestion = questions.find(
        question => !data.branches.some(branch => branch.questionNodeId === question.id)
      );
      const runningBranch = data.branches.find(branch => {
        const run = data.runs.find(item => item.branchId === branch.id);
        const attempt = run?.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      });
      let stateText: string;
      let stateClass: string;
      if (this.aimBusy) {
        const activeTitle = this.notes.get(this.aimActiveQuestionNodeId ?? "")?.title ?? this.map.title;
        const planning = this.aimActivityKind === "planning";
        stateText =
          this.aimActivityKind === "clarifying"
            ? t("ui.aim_preparing_clarification")
            : this.aimProgress
              ? this.aimStageText()
              : t(planning ? "ui.aim_status_planning_0" : "ui.aim_status_researching_0", activeTitle);
        stateClass = "running";
      } else if (runningBranch) {
        const activeTitle = this.notes.get(runningBranch.questionNodeId)?.title ?? this.map.title;
        stateText = t("ui.aim_status_researching_0", activeTitle);
        stateClass = "running";
      } else if (!questions.length) {
        stateText = t("ui.aim_status_ready");
        stateClass = "idea";
      } else if (pendingQuestion) {
        stateText = t("ui.aim_status_waiting_answer_0", this.notes.get(pendingQuestion.id)?.title ?? "");
        stateClass = "idea";
      } else if (data.branches.some(branch => branch.results.some(result => result.kind === "conclusion"))) {
        stateText = t("ui.aim_status_complete");
        stateClass = "completed";
      } else {
        stateText = t("ui.aim_status_exploring");
        stateClass = "idea";
      }
      statusbar.createSpan({ cls: "vam-aim-status-title", text: "AIM" });
      const stateEl = statusbar.createSpan({ cls: `vam-aim-status-value vam-status-${stateClass}`, text: stateText });
      if (this.aimBusy && this.aimProgress) {
        this.aimProgressEls.set("status", stateEl);
        statusbar.createSpan({ cls: "vam-hint vam-aim-eta", text: t("ui.aim_eta_hint") });
      }
      if (this.aimBusy) {
        this.button(statusbar, t("ui.stop_research"), () => {
          this.aimController?.abort();
        });
        const from = { nodeId: this.aimActiveQuestionNodeId, branchId: this.aimProgress?.branchId ?? null };
        const steer = this.button(statusbar, t("ui.aim_steer"), () =>
          new AimSteerModal(this.app, direction => void this.steerAim(from, direction)).open()
        );
        steer.setAttr("title", t("ui.aim_steer_hint"));
      }
      const attribution = this.contentEl.createDiv("vam-aim-attribution");
      attribution.createSpan({ text: t("ui.aim_attribution") });
      attribution.createEl("a", {
        text: t("ui.aim_source_project"),
        href: "https://github.com/InternLM/MindSearch",
        attr: { target: "_blank", rel: "noopener noreferrer" }
      });
      attribution.createEl("a", {
        text: t("ui.aim_source_paper"),
        href: "https://arxiv.org/abs/2407.20183",
        attr: { target: "_blank", rel: "noopener noreferrer" }
      });
    }
    if (!this.builtIn && this.map?.aim) {
      const data = this.map.aim;
      const isAnswered = (node: MapNode) => data.branches.some(branch => branch.questionNodeId === node.id);
      const pending = this.map.nodes.find(node => node.aimKind === "question" && node.aimQuestion && !isAnswered(node));
      const selectedQuestion =
        selectedNode?.aimKind === "question" && selectedNode.aimQuestion ? selectedNode : undefined;
      if (selectedQuestion || pending) {
        const actions = toolbar.createDiv("vam-aim-actions");
        // Answering an already answered question opens an alternative branch; label it so it is never mistaken for the pending question.
        if (pending && pending.id !== selectedQuestion?.id)
          this.button(
            actions,
            t("ui.aim_answer_pending_question"),
            () => {
              this.selected = pending.id;
              this.render();
              this.focusNode(pending);
              this.openAimAnswer(pending);
            },
            this.aimBusy
          );
        if (selectedQuestion)
          this.button(
            actions,
            t(isAnswered(selectedQuestion) ? "ui.aim_answer_again_new_branch" : "ui.aim_answer_question"),
            () => this.openAimAnswer(selectedQuestion),
            this.aimBusy
          );
        if (selectedQuestion && this.aimFailedReports.has(selectedQuestion.id))
          this.button(
            actions,
            t("ui.aim_retry_saved_report"),
            () => {
              void this.retryAimFromSavedReport(selectedQuestion.id);
            },
            this.aimBusy
          );
      }
    }
    if (!this.map && (this.history.canUndo || this.history.canRedo)) {
      const undo = this.button(
        toolbar,
        t("ui.undo"),
        () => this.enqueue(() => this.travel(false)),
        !this.history.canUndo
      );
      undo.dataset.history = "undo";
      const redo = this.button(
        toolbar,
        t("ui.redo"),
        () => this.enqueue(() => this.travel(true)),
        !this.history.canRedo
      );
      redo.dataset.history = "redo";
      this.updateHistoryButtons();
    }
    if (this.deletedMap?.deleted)
      this.button(toolbar, t("ui.restore_deleted_map"), () => this.enqueue(() => this.restoreDeletedMapFromUi()));
    const startingSelection = this.startingTasks.get(this.selectionTaskKey());
    if (
      startingSelection &&
      !(this.integrationTask?.mapPath === this.path && this.integrationTask.state === "running")
    ) {
      // The dialog hid itself and the run has not produced its task yet: the bar still shows it and offers Stop.
      const state = this.contentEl.createDiv("vam-integration-progress");
      state.setAttr("aria-live", "polite");
      state.createSpan({ text: t("ui.integration_running") });
      this.button(state, t("ui.stop_research"), () => this.startingTasks.get(this.selectionTaskKey())?.abort());
    }
    if (
      this.integrationTask &&
      this.integrationTask.mapPath === this.path &&
      !(startingSelection && this.integrationTask.state !== "running")
    ) {
      const task = this.integrationTask,
        state = this.contentEl.createDiv("vam-integration-progress");
      state.setAttr("aria-live", "polite");
      state.createSpan({
        text:
          task.state === "running"
            ? task.progress || t("ui.integration_running")
            : task.state === "applying"
              ? t("ui.integration_running")
              : task.state === "directions"
                ? t("ui.choose_synthesis_direction")
                : task.state === "failed"
                  ? task.progress || t("ui.integration_failed")
                  : t("ui.research_stopped_existing_content_was_preserved")
      });
      if (task.state === "running")
        this.renderTaskProgress(state, this.contentEl, this.taskProgressKey("integration", task.mapPath));
      if (task.state === "running")
        this.button(state, t("ui.stop_research"), () => {
          task.controller.abort();
          task.state = "cancelled";
          this.render();
        });
      if (task.state === "directions")
        this.button(state, t("ui.choose_synthesis_direction"), () => this.openSelectionSynthesis(task)).addClass(
          "vam-badge-new"
        );
      if (task.state === "failed" || task.state === "cancelled") {
        this.button(state, t("ui.try_again"), () => this.retrySelectionSynthesis(task));
        this.button(state, t("ui.discard_synthesis"), () => this.discardSelectionSynthesis());
      }
    }
    if (!this.map) {
      const empty = this.contentEl.createDiv("vam-empty-state");
      empty.createEl("h2", {
        text: this.plugin.repo.workspaceExists() ? t("ui.no_map_open") : t("ui.agent_workspace_is_missing")
      });
      empty.createEl("p", {
        text: this.plugin.repo.workspaceExists()
          ? t("ui.open_or_create_map_hint")
          : t("ui.the_base_folders_can_be_safely_recreated_existing_notes_will")
      });
      const actions = empty.createDiv("vam-empty-actions");
      if (!this.plugin.repo.workspaceExists()) {
        this.button(actions, t("ui.reconnect_existing_workspace"), () =>
          this.enqueue(() => this.plugin.offerWorkspaceReconnect())
        ).addClass("mod-cta");
        this.button(actions, t("ui.repair_agent_workspace"), () => this.enqueue(() => this.plugin.repairWorkspace()));
      }
      this.button(actions, t("ui.create_a_new_mind_map"), () => this.openNewMindMapModal()).addClass("mod-cta");
      this.button(actions, t("ui.aim_create_map"), () => this.openAimStart());
      this.button(actions, t("ui.view_sample"), () => this.enqueue(() => this.openBuiltInSample(true)));
      if (this.deletedMap?.deleted)
        this.button(actions, t("ui.restore_deleted_map"), () => this.enqueue(() => this.restoreDeletedMapFromUi()));
      return;
    }
    if (this.builtIn && this.showSampleTour) {
      const tour = this.contentEl.createDiv("vam-sample-tour");
      const steps = [
        {
          id: "explore",
          title: t("ui.tour_1_title"),
          body: t("ui.tour_1_body")
        },
        {
          id: "constraints",
          title: t("ui.tour_2_title"),
          body: t("ui.tour_2_body")
        },
        {
          id: "food",
          title: t("ui.tour_3_title"),
          body: t("ui.tour_3_body")
        },
        {
          id: "journey",
          title: t("ui.tour_4_title"),
          body: t("ui.tour_4_body")
        },
        {
          id: "next",
          title: t("ui.tour_5_title"),
          body: t("ui.tour_5_body")
        }
      ];
      const step = steps[this.sampleTourStep];
      const copy = tour.createDiv();
      copy.createEl("strong", { text: step.title });
      copy.createEl("p", { text: step.body });
      const actions = tour.createDiv("vam-sample-tour-actions");
      if (this.sampleTourStep > 0)
        this.button(actions, t("ui.back"), () => {
          this.sampleTourStep--;
          this.selectSampleNode(steps[this.sampleTourStep].id);
        });
      if (this.sampleTourStep < steps.length - 1)
        this.button(actions, t("ui.next"), () => {
          this.sampleTourStep++;
          this.selectSampleNode(steps[this.sampleTourStep].id);
        }).addClass("mod-cta");
      this.button(actions, this.sampleTourStep === steps.length - 1 ? t("ui.finish_tour") : t("ui.skip_tour"), () => {
        this.showSampleTour = false;
        this.plugin.settings.sampleTourVersionSeen = SAMPLE_TOUR_VERSION;
        void this.plugin.saveSettings();
        this.render();
      });
    }
    if (this.builtIn) {
      const start = this.contentEl.createDiv("vam-sample-start");
      const copy = start.createDiv();
      copy.createEl("strong", { text: t("ui.start_using_vam") });
      copy.createEl("p", { text: t("ui.sample_start_hint") });
      const actions = start.createDiv("vam-sample-start-actions");
      this.button(actions, t("ui.duplicate_to_my_workspace"), () =>
        this.enqueue(async () => this.openMapInMutation(await this.plugin.duplicateBuiltInSample()))
      ).addClass("mod-cta");
      this.button(actions, t("ui.create_an_empty_mind_map"), () => this.promptEmptyMap());
      if (this.needsConnectionCheck()) this.renderConnectionCheck(actions);
      // The opening screen of the chat: one sentence builds a new map of the user's own, which the sample cannot be.
      start.createDiv("vam-sample-start-chat");
    }
    if (!this.builtIn && !this.map.aim) this.renderMultiResearchStatus(this.contentEl);
    if (!this.builtIn && !this.map.aim) this.renderRelevanceStatus(this.contentEl);
    if (!this.builtIn && !this.map.aim) this.renderBackgroundBars(this.contentEl);
    // An empty map has nothing to select: leave topic selection (undo can empty a map while the bar is open).
    if (!this.map.nodes.length && !this.builtIn) {
      this.integrationMode = false;
      this.multiSelected.clear();
    }
    const tools = createDiv("vam-map-tools");
    if (!this.builtIn) {
      const aimMode = !!this.map.aim;
      if (!aimMode) {
        this.button(tools, t("ui.topic"), () => this.enqueue(() => this.addNode(null))).addClass("mod-cta");
        this.iconButton(tools, "chevron-down", t("ui.topic_more_options"), event => this.openTopicMenu(event)).addClass(
          "vam-topic-more"
        );
      }
      if (!aimMode) {
        const integrate = this.button(
          tools,
          this.integrationMode ? t("ui.finish_topic_selection") : t("ui.select_topics"),
          () => {
            this.integrationMode = !this.integrationMode;
            this.multiSelected.clear();
            this.selected = null;
            this.render();
          }
        );
        integrate.setAttr("aria-pressed", String(this.integrationMode));
        if (this.integrationMode) integrate.addClass("is-active");
        this.renderRelevanceGoalControl(tools);
      }
    }
    const workspace = this.contentEl.createDiv("vam-workspace");
    // The workspace is a row: the chat window (put in first by mountMapChat), the canvas, the sample's inspector.
    const canvas = workspace.createDiv("vam-canvas");
    this.viewportEl = canvas.createDiv("vam-viewport");
    if (this.integrationMode) this.viewportEl.addClass("is-selecting");
    // Canvas controls float over the map instead of stacking a second toolbar above it; the overlay covers the canvas only.
    const overlay = canvas.createDiv("vam-canvas-overlay");
    if (tools.childElementCount) overlay.appendChild(tools);
    else tools.remove();
    this.mountMapChat(workspace, overlay);
    if (this.relevancePanelEl) this.placeRelevancePanel(this.relevancePanelEl);
    // The gesture hint goes away once the user has panned or zoomed; select mode keeps its gesture hint inside the selection bar, never over the canvas.
    // In select mode the selection bar (bottom-left) owns that space, so no hint is drawn there.
    this.hintEl =
      !this.integrationMode && !this.plugin.settings.canvasHintSeen
        ? overlay.createSpan({
            cls: "vam-hint vam-canvas-hint",
            text: t("ui.drag_empty_space_to_pan_scroll_to_zoom_click_a_node_to_open")
          })
        : null;
    const zoom = overlay.createDiv("vam-zoom-controls");
    this.iconButton(zoom, "minus", t("ui.zoom_out"), () => this.zoomBy(1 / 1.2));
    const zoomReset = zoom.createEl("button", {
      text: `${Math.round(this.map.viewport.zoom * 100)}%`,
      cls: "vam-zoom",
      attr: { "aria-label": t("ui.zoom_level_0_reset", `${Math.round(this.map.viewport.zoom * 100)}%`) }
    });
    zoomReset.addEventListener("click", event => {
      event.stopPropagation();
      if (this.map) this.zoomBy(1 / this.map.viewport.zoom);
    });
    this.zoomLabel = zoomReset;
    this.iconButton(zoom, "plus", t("ui.zoom_in"), () => this.zoomBy(1.2));
    this.iconButton(zoom, "maximize", t("ui.show_all"), () => this.fit());
    const present = this.iconButton(zoom, "presentation", t("ui.presentation_start"), () => this.startPresentation());
    present.disabled = !this.canPresent();
    if (!this.builtIn) {
      const layout = zoom.createEl("button", { text: t("ui.layout"), cls: "vam-layout-button" });
      layout.setAttr("aria-haspopup", "menu");
      layout.addEventListener("click", event => {
        event.stopPropagation();
        this.openLayoutMenu(event);
      });
    }
    this.stageEl = this.viewportEl.createDiv("vam-stage");
    this.stageEl.setAttr("role", "tree");
    this.stageEl.setAttr("aria-label", this.map.title);
    this.stageEl.setAttr("aria-multiselectable", String(this.integrationMode));
    this.releaseCovers();
    this.cardEls.clear();
    this.cardChecks.clear();
    this.selectionBarEl = null;
    this.edgesEl = createSvg("svg");
    this.edgesEl.addClass("vam-edges");
    this.edgesEl.setAttribute("aria-hidden", "true");
    this.stageEl.appendChild(this.edgesEl);
    const shown = this.canvasNodes();
    if (this.selected && !shown.some(node => node.id === this.selected)) this.selected = null;
    this.multiSelected = new Set([...this.multiSelected].filter(id => shown.some(node => node.id === id)));
    if (this.integrationMode) this.selectionBarEl = this.renderSelectionBar(canvas);
    this.tabStopId = this.defaultTabStop(shown);
    this.renderingCard = true;
    try {
      for (const node of shown) this.renderNode(node);
    } finally {
      this.renderingCard = false;
    }
    this.renderAimPendingCards(shown);
    this.renderCanvasItems();
    if (this.focusNodeId) {
      this.restoringFocus = true;
      try {
        this.stageEl
          .querySelector<HTMLElement>(`[data-node-id="${CSS.escape(this.focusNodeId)}"]`)
          ?.focus({ preventScroll: true });
      } finally {
        this.restoringFocus = false;
      }
      this.focusNodeId = null;
    }
    if (this.focusResizeNodeId) {
      this.restoringFocus = true;
      try {
        this.stageEl
          .querySelector<HTMLElement>(`[data-node-id="${CSS.escape(this.focusResizeNodeId)}"] .vam-card-resize`)
          ?.focus({ preventScroll: true });
      } finally {
        this.restoringFocus = false;
      }
      this.focusResizeNodeId = null;
    }
    if (!this.map.nodes.length) {
      this.emptyMapEl = this.viewportEl.createDiv("vam-empty");
      this.fillEmptyMap(this.emptyMapEl);
    }
    this.setupPan();
    this.setupCanvasImageInput();
    this.applyInitialViewport();
    this.transform();
    this.drawEdges();
    if (this.builtIn && this.selected) {
      const node = this.map.nodes.find(n => n.id === this.selected);
      if (node) {
        this.renderInspector(workspace, node);
        // The inspector takes width from the canvas, which the window's fold limit counts.
        this.syncChatNarrow();
      }
    }
    restoreRelevanceFocus();
    restoreChatFocus();
    this.applyPresentationMarks();
    restoreSearch();
  }
  /** What the empty canvas says: the usual hint, or (while the chat builds the map, or waits for a plan) what is happening. */
  private emptyCanvasState(): "idle" | "building" | "plan" {
    const chat = this.chat;
    if (!chat || this.builtIn || this.map?.aim) return "idle";
    if (chat.isBusy || this.chatApplying) return "building";
    return chat.pendingPlan() ? "plan" : "idle";
  }
  private fillEmptyMap(box: HTMLElement): void {
    if (!this.map) return;
    const state = this.emptyCanvasState();
    box.toggleClass("is-building", state === "building");
    box.toggleClass("is-waiting", state === "plan");
    if (state === "building") {
      // Three faint card outlines, no motion: the map is on its way.
      box.createSpan({ text: t("ui.map_chat_canvas_building") });
      const skeleton = box.createDiv({ cls: "vam-chat-skeleton", attr: { "aria-hidden": "true" } });
      for (let card = 0; card < 3; card++) skeleton.createDiv("vam-chat-skeleton-card");
      return;
    }
    if (state === "plan") {
      box.createSpan({ text: t("ui.map_chat_canvas_plan") });
      return;
    }
    box.createSpan({
      text: t(this.map.aim ? "ui.aim_empty_map_hint" : "ui.this_mind_map_has_no_topics_click_topic_to_create_the_first")
    });
    if (!this.map.aim) this.button(box, t("ui.topic"), () => this.enqueue(() => this.addNode(null)));
  }
  /** The chat started or ended something: an empty canvas follows it. */
  private refreshEmptyMap(): void {
    const box = this.emptyMapEl;
    if (!box || this.closed || !this.map || this.map.nodes.length) return;
    box.empty();
    this.fillEmptyMap(box);
  }
  /** `shownNode` may be a display copy (sorted by relevance): it only supplies where the card is drawn. */
  private renderNode(shownNode: MapNode): void {
    if (!this.stageEl) return;
    // Every handler below acts on the real node, so nothing written to the map can carry display coordinates.
    const node = this.map?.nodes.find(item => item.id === shownNode.id) ?? shownNode;
    const note = this.notes.get(node.id),
      card = this.stageEl.createDiv({
        cls: `vam-node${node.id === this.selected || this.multiSelected.has(node.id) ? " is-selected" : ""}`
      });
    this.cardEls.set(node.id, card);
    this.paintCut(card, node.id);
    if (this.structureHighlight.has(node.id)) card.addClass("vam-structure-suggested");
    card.setAttr("role", "treeitem");
    card.setAttr("aria-level", String(this.nodeDepth(node)));
    card.setAttr("aria-selected", String(node.id === this.selected || this.multiSelected.has(node.id)));
    if (node.aimKind) card.setAttr("data-aim-kind", node.aimKind);
    if (node.aimKind === "conclusion") {
      const background = createSvg("svg");
      background.addClass("vam-conclusion-background");
      background.setAttribute("viewBox", "0 0 100 100");
      background.setAttribute("preserveAspectRatio", "none");
      background.setAttribute("aria-hidden", "true");
      background.setAttribute("focusable", "false");
      const shape = createSvg("polygon");
      shape.setAttribute("points", "25,0.5 75,0.5 99.5,50 75,99.5 25,99.5 0.5,50");
      shape.setAttribute("vector-effect", "non-scaling-stroke");
      background.appendChild(shape);
      card.appendChild(background);
    }
    // The type's SVG shape goes behind the text (an AIM card has none: its kind is always an ordinary topic).
    const kind = this.topicKindOf(node.id);
    renderShapeBackground(card, kind);
    card.dataset.nodeId = node.id;
    // Research state drives the card's frame: frontier (idea), running, concluded, or failed.
    const queued = this.isResearchQueued(node);
    const merging = this.isMerging(node.id);
    card.dataset.status =
      merging ||
      this.plugin.running?.has(node.path) ||
      this.plugin.quickExpandPending?.has(node.path) ||
      this.startingTasks.has(node.path)
        ? "running"
        : queued
          ? "queued"
          : (note?.status ?? "error");
    card.style.left = `${shownNode.x}px`;
    card.style.top = `${shownNode.y}px`;
    if (shownNode.width) card.style.width = `${shownNode.width}px`;
    card.tabIndex = node.id === this.tabStopId ? 0 : -1;
    card.addEventListener("dragover", event => this.onCardDragOver(event, card, node));
    card.addEventListener("dragleave", event => this.onCardDragLeave(event, card));
    card.addEventListener("drop", event => this.onCardDrop(event, card, node));
    const header = card.createDiv("vam-node-header");
    this.labelCard(card, note?.title ?? t("ui.note_missing"));
    if (this.integrationMode) {
      const select = header.createEl("input", { type: "checkbox" });
      select.checked = this.multiSelected.has(node.id);
      select.setAttr("aria-label", note?.title ?? node.path);
      // The card itself is the tab stop; a checkbox per card would add one tab stop per topic.
      select.tabIndex = -1;
      this.cardChecks.set(node.id, select);
      select.addEventListener("click", event => {
        event.stopPropagation();
        if (select.checked) this.multiSelected.add(node.id);
        else this.multiSelected.delete(node.id);
        this.commitSelection(this.selected, this.selected, [node.id]);
      });
    }
    const batch = this.plugin.expansionBatches.get(node.path);
    const research = this.builtIn ? undefined : this.plugin.researchProgress?.get(node.path);
    if (research) this.researchSigs.set(node.path, this.researchSig(research));
    else this.researchSigs.delete(node.path);
    const active =
      merging ||
      this.plugin.running?.has(node.path) ||
      this.plugin.quickExpandPending?.has(node.path) ||
      this.startingTasks.has(node.path);
    const doc = this.map,
      aimData = doc?.aim;
    // An AIM question, and the AIM root topic that owns the first branch, show the branch progress instead of note state.
    const aimProgress =
      !!aimData &&
      (node.aimKind === "question" ||
        (node.aimKind === "topic" &&
          aimData.branches.some(branch => branch.questionNodeId === node.id && !branch.parentBranchId)));
    if (doc && aimData && aimProgress) {
      const status = aimQuestionStatus(doc, node.id, this.aimActiveQuestionNodeId);
      const key: Record<AimQuestionStatus, TranslationKey> = {
        running: "ui.aim_branch_running",
        completed: "ui.aim_branch_completed",
        partial: "ui.aim_branch_partial",
        failed: "ui.aim_branch_failed",
        cancelled: "ui.aim_branch_cancelled",
        not_started: "ui.aim_branch_not_started"
      };
      header.createSpan({
        cls: `vam-status vam-aim-question-status vam-status-${status === "running" ? "running" : status === "completed" ? "completed" : status === "not_started" ? "idea" : "error"}`,
        text:
          status === "not_started" && aimData.branches.some(branch => branch.questionNodeId === node.id)
            ? t("ui.aim_answered_not_started")
            : t(key[status])
      });
    } else if (!node.aimKind || active || queued || !note || note.status !== "completed" || research) {
      const statusText = research
        ? this.researchStageText(research)
        : merging
          ? t("ui.merging")
          : active
            ? t("ui.ai_running")
            : queued
              ? t("ui.research_queued")
              : note?.status === "completed"
                ? t("ui.researched")
                : note
                  ? topicStatusLabel(note.status, this.plugin.settings.language)
                  : t("ui.note_missing");
      // A researched topic is the normal state, so only the other states earn a pill; screen readers still hear it.
      if (research) {
        const chip = header.createSpan({ cls: "vam-status vam-status-running" });
        // Not a live region: this card is rebuilt on every render. Stage changes go through the view's announcer.
        const stageEl = chip.createSpan({ cls: "vam-research-stage", text: statusText });
        stageEl.setAttr("title", statusText);
        const elapsedEl = chip.createSpan({
          cls: "vam-research-elapsed",
          text: this.researchElapsedText(research.startedAt)
        });
        elapsedEl.setAttr("aria-hidden", "true");
        this.trackResearchElapsed(elapsedEl, research.startedAt);
        if (research.slow)
          header.createSpan({ cls: "vam-status vam-research-slow", text: t("ui.research_slow_waiting") });
      } else if (!note || note.status !== "completed" || active || queued) {
        const chip = header.createSpan({
          cls: `vam-status vam-status-${active ? "running" : queued ? "queued" : (note?.status ?? "error")}`,
          text: statusText
        });
        if (active) chip.setAttr("role", "status");
      }
      if (note) this.labelCard(card, t("ui.topic_card_label_0_1", note.title, statusText));
    }
    // Offline relevance grading: mind maps only, and only a valid tier shows anything. Side topics get a dashed border (see styles.css)
    // but are never hidden, moved or collapsed.
    const relevance = !node.aimKind && !this.map?.aim && !this.builtIn ? note?.relevance : undefined;
    if (relevance) {
      const tierLabel = t(RELEVANCE_LABEL[relevance.tier]);
      card.dataset.relevance = relevance.tier;
      const tagButton = renderRelevanceTagButton(
        header,
        relevance.tier,
        tierLabel,
        t("ui.relevance_tag_label_0", tierLabel),
        button => this.openRelevanceMenu(node, relevance.tier, button),
        this.plugin.relevanceGrades.get(this.path)?.status === "running"
      );
      // An AI grade carries no explanation; only a hand-set tier says where it came from.
      if (relevance.manual) {
        const manualText = t("ui.relevance_manual_reason");
        setTooltip(tagButton, manualText);
        card.setAttr("aria-description", t("ui.relevance_description_0_1", tierLabel, manualText));
      }
      const named = cardLabels.get(card)?.textContent;
      if (named) this.labelCard(card, t("ui.topic_card_label_0_1", named, tierLabel));
    }
    // A hypothesis: quiet "Hypothesis · strength" tag; every non-ordinary type sets `data-topic-kind` and is named in the card's accessible name.
    if (kind !== "topic") {
      card.dataset.topicKind = kind;
      const strength = this.hypothesisStrengthOf(node.id);
      const kindText = strength ? this.hypothesisTagText(strength) : t(TOPIC_KIND_SHAPES[kind].labelKey);
      if (strength) renderHypothesisTag(header, strength, kindText);
      // The other typed cards name their type in the same quiet tag, coloured by the type's hue (decision 35); an ordinary topic shows none.
      else header.createSpan({ cls: "vam-hypothesis-tag vam-kind-tag", text: kindText });
      const named = cardLabels.get(card)?.textContent;
      if (named) this.labelCard(card, t("ui.topic_card_label_0_1", named, kindText));
    }
    // Markers (done, warning, star, priority): decorative symbols in the header, named in the card's accessible name.
    this.paintCardMarkers(card, header, node.id);
    // The model tag follows the marker row (see paintModelTag).
    this.paintModelTag(card, header, note);
    // The topic colour comes last: its attribute and its name part (see paintCardColor).
    this.paintCardColor(card, note, !!node.aimKind);
    // Failure reasons are shown on the card, not only in a hover tooltip.
    const errorDetails: string[] = [];
    if (note?.detailFormatIssues?.length) {
      const issue = header.createSpan({ cls: "vam-status vam-status-error", text: t("ui.detail_format_unmet") });
      issue.setAttr("title", note.detailFormatIssues.join("\n"));
      errorDetails.push(...note.detailFormatIssues);
    }
    if (note?.status === "error" && note.lastError) errorDetails.push(note.lastError);
    if (batch) {
      const currentNode = batch.currentPath ? this.map?.nodes.find(item => item.path === batch.currentPath) : undefined;
      const currentTitle = currentNode ? this.notes.get(currentNode.id)?.title : undefined;
      const label = this.batchProgressLabel(
        t("ui.shallow_research_counts", batch.succeeded, batch.total),
        batch,
        currentTitle ? t("ui.shallow_research_current", currentTitle) : undefined
      );
      header.createSpan({
        cls: `vam-status vam-status-${batch.status === "running" ? "running" : batch.failures.length ? "error" : "completed"}`,
        text: label
      });
      if (batch.status === "running")
        this.button(header, t("ui.stop_research"), () => this.plugin.expansionCoordinator.stop(node.path));
      if (batch.failures.length) {
        const failure = header.createSpan({
          cls: "vam-status vam-status-error",
          text: `${batch.failures.length} ${t("ui.failed")}`
        });
        failure.setAttr("title", batch.failures.join("\n"));
        errorDetails.push(...batch.failures);
      }
      this.renderRetryFailedButton(header, node.path, batch);
    }
    // One Stop for every AI run on this card: a dialog's run still starting, guided expand, and research. A batch and
    // a synthesis show their own Stop; a child researched by a running batch is stopped through its batch.
    const ownSynthesis = this.synthesisTasks.get(node.path);
    const parentNode = node.parentId ? this.map?.nodes.find(item => item.id === node.parentId) : undefined;
    const batchChild = !!parentNode && !!this.plugin.expansionCoordinator?.isRunning(parentNode.path);
    const stoppable =
      this.startingTasks.has(node.path) ||
      this.plugin.quickExpandPending?.has(node.path) ||
      (this.plugin.running?.has(node.path) && this.plugin.activeTasks.has(node.path) && !batchChild);
    if (
      stoppable &&
      batch?.status !== "running" &&
      !(ownSynthesis?.state === "running" && ownSynthesis.mapPath === this.path)
    ) {
      this.button(header, t("ui.stop_research"), () =>
        (this.startingTasks.get(node.path) ?? this.plugin.activeTasks.get(node.path))?.abort()
      );
    }
    if (research?.slow && research.resend)
      this.button(header, t("ui.research_resend"), () => this.plugin.researchProgress.get(node.path)?.resend?.());
    if (research?.stage === "charts")
      this.button(header, t("ui.stop_adding_charts"), () => this.plugin.abortChartJobs(node.path));
    const pendingCount = this.plugin.pendingSuggestions.get(node.path)?.length ?? 0;
    if (pendingCount && !this.builtIn && !this.integrationMode && !this.map?.aim)
      this.button(header, t("ui.view_0_expansion_suggestions", pendingCount), () =>
        this.openNodePanel(node, "proposals")
      ).addClass("vam-badge-new");
    // A Quick answer that says the model's knowledge was not enough offers the Standard run (never while AI works on it).
    if (
      note &&
      note.researchMode === "local" &&
      !this.builtIn &&
      !this.integrationMode &&
      !this.map?.aim &&
      !node.aimKind &&
      !active &&
      !queued &&
      !research &&
      !merging &&
      hasKnowledgeGapMarker(note.detail)
    )
      this.button(header, t("ui.rerun_standard"), () => this.rerunStandard(node)).setAttr(
        "aria-label",
        t("ui.rerun_standard_0", note.title)
      );
    // A research that failed with a provider error (quota, login, unavailable model) offers one retry on the other provider.
    if (
      note?.status === "error" &&
      !this.integrationMode &&
      !node.aimKind &&
      !active &&
      !queued &&
      !research &&
      !merging
    )
      this.renderOtherProviderButton(header, [node]);
    const waitingOutline = this.quickOutlines.get(node.path);
    if (
      waitingOutline &&
      waitingOutline.mapPath === this.path &&
      !this.builtIn &&
      !this.integrationMode &&
      !this.map?.aim
    )
      this.button(header, t("ui.review_outline_0", outlineProposals(waitingOutline.nodes).length), () =>
        this.openNextStep(node)
      ).addClass("vam-badge-new");
    const synthesis = this.synthesisTasks.get(node.path);
    if (synthesis && synthesis.mapPath === this.path && !this.builtIn && !this.integrationMode && !this.map?.aim) {
      if (synthesis.state === "running") {
        if (synthesis.progress) header.createSpan({ cls: "vam-status vam-status-running", text: synthesis.progress });
        this.button(header, t("ui.stop_research"), () => synthesis.controller.abort());
      } else if (synthesis.state === "directions")
        this.button(header, t("ui.choose_synthesis_direction"), () => this.openNextStep(node)).addClass(
          "vam-badge-new"
        );
      else {
        header.createSpan({
          cls: "vam-status vam-status-error",
          text: synthesis.state === "cancelled" ? t("ui.ai_task_cancelled") : t("ui.failed"),
          attr: { title: synthesis.progress }
        });
        this.button(header, t("ui.try_again"), () => this.retrySynthesis(node));
        this.button(header, t("ui.discard_synthesis"), () => this.discardSynthesis(node));
      }
    }
    // Hover-only tools float above the card's top edge, so showing them (hover, focus, selection) never moves the card's
    // content. What must always show (status, stop and review actions, a folded branch's count) stays in the header.
    // Every tool is labelled: the toolbar floats, so its width never moves the card. Order: fold, structure, rename,
    // select subtopics, details, then the AI action last.
    const tools = card.createDiv("vam-node-tools");
    const count = descendants(this.map!.nodes, node.id).size;
    if (count && !this.builtIn) {
      // A folded branch keeps its count on the card; the fold action itself is a hover tool.
      const collapse = this.button(
        node.collapsed ? header : tools,
        node.collapsed ? t("ui.expand_0", count) : t("ui.collapse"),
        () =>
          this.enqueue(() =>
            this.mapChange(map => {
              const n = map.nodes.find(n => n.id === node.id)!;
              n.collapsed = !n.collapsed;
              map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
            })
          )
      );
      collapse.addClass("vam-collapse-button", ...(node.collapsed ? ["is-collapsed"] : []));
      collapse.setAttr("aria-expanded", String(!node.collapsed));
    }
    if (!this.builtIn && !this.integrationMode) {
      if (!this.map?.aim) {
        const structure = this.button(tools, t("ui.node_tool_links"), () => this.openNodePanel(node, "structure"));
        structure.addClass("vam-node-tool", "vam-structure-tool");
        structure.setAttr("aria-label", t("ui.structure_and_links"));
        if (note)
          this.button(tools, t("ui.node_tool_rename"), () =>
            new NameModal(this.app, t("ui.new_topic_name"), note.title, title =>
              this.enqueue(() => this.noteChange(node, { title }))
            ).open()
          ).addClass("vam-node-tool", "vam-rename-tool");
        // Select every direct subtopic in one press. A folded card hides them, so it offers Expand instead.
        if (!node.collapsed && this.map!.nodes.some(item => item.parentId === node.id)) {
          const select = this.button(tools, t("ui.select_subtopics"), () => this.selectSubtopics(node));
          select.addClass("vam-node-tool", "vam-select-subtopics-tool");
          select.setAttr("aria-label", t("ui.select_subtopics_hint"));
        }
      }
      if (node.aimKind === "question") {
        const remove = this.button(tools, t("ui.node_tool_remove"), () => this.confirmRemoveNode(node));
        remove.addClass("vam-node-tool", "vam-remove-tool");
        remove.setAttr("aria-label", t("ui.remove_from_map"));
      }
      if (
        this.map?.aim &&
        node.aimKind === "synthesis" &&
        this.map.aim.branches.some(branch => branch.results.some(result => result.nodeId === node.id))
      ) {
        const next = this.button(
          header,
          t("ui.aim_new_question"),
          () => void this.planAimFromSelection(node.id),
          this.aimBusy
        );
        next.addClass("vam-node-tool", "vam-pinned-tool");
        next.setAttr("aria-label", t("ui.aim_new_question_hint"));
        next.setAttr("title", t("ui.aim_new_question_hint"));
      }
      const assumptions = node.aimKind === "conclusion" && note ? readOpenItems(note.detail) : [];
      if (this.map?.aim && assumptions.length) {
        const correct = this.button(
          header,
          t("ui.aim_correct_assumption"),
          () =>
            new AimAssumptionModal(this.app, assumptions, (assumption, correction) => {
              void this.correctAimAssumption(node.id, assumption, correction);
            }).open(),
          this.aimBusy
        );
        correct.addClass("vam-node-tool", "vam-pinned-tool");
        correct.setAttr("title", t("ui.aim_correct_assumption_hint"));
      }
      if (this.map?.aim && node.aimKind === "conclusion") {
        const steer = this.button(
          header,
          t("ui.aim_steer"),
          () => new AimSteerModal(this.app, direction => void this.steerAim({ nodeId: node.id }, direction)).open(),
          this.aimBusy
        );
        steer.addClass("vam-node-tool", "vam-pinned-tool");
        steer.setAttr("title", t("ui.aim_steer_hint"));
      }
    }
    const details = this.button(tools, t("ui.node_tool_details"), () =>
      this.builtIn ? this.selectSampleNode(node.id) : this.openDetails(node)
    );
    details.addClass("vam-node-tool", "vam-detail-button");
    // The sample's longer description is a tooltip, so the accessible name still starts with the visible text.
    if (this.builtIn) details.setAttr("title", t("ui.view_sample_content"));
    else details.setAttr("aria-label", t("ui.open_details_in_right_sidebar"));
    if (!this.builtIn && !this.integrationMode && !this.map?.aim)
      this.button(tools, t("ui.ai_explore"), () => this.openNextStep(node)).addClass("vam-node-tool", "vam-ai-explore");
    if (!this.builtIn && !this.integrationMode && !this.map?.aim) {
      const add = this.button(card, "+", () => this.enqueue(() => this.addNode(node)));
      add.addClass("vam-add-child");
      add.setAttr("aria-label", t("ui.add_subtopic_manually"));
    }
    // The cover frame sits above the title; it adds nothing when the topic has no local image.
    if (note && !this.builtIn) this.paintCover(card, node.path);
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    title.setAttr("dir", "auto");
    // Double-click renames, the same dialog as F2 and the Rename tool. It is handled on the card: enableDrag captures the
    // pointer on the card, so a real mouse reports the card (not the title) as the dblclick target.
    if (note && !this.builtIn && !this.integrationMode && !this.map?.aim)
      card.addEventListener("dblclick", event => {
        const target = event.target as Element | null;
        if (target?.closest?.("button")) return;
        const box = title.getBoundingClientRect();
        const inside =
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom;
        if (target !== title && !inside) return;
        event.preventDefault();
        this.renameNode(node, note.title);
      });
    // An unresearched topic's placeholder summary repeats its status, so the frontier card stays quiet.
    // While a run streams its answer, the unsaved summary preview takes the place of the stored summary.
    if (research?.preview?.summary)
      this.fillCardPreview(card.createEl("p", { cls: "vam-card-summary" }), research.preview.summary);
    else if (!note || !isPlaceholder(note.summary))
      card.createEl("p", {
        cls: "vam-card-summary",
        text: note?.summary ?? t("ui.the_file_was_moved_or_deleted_you_can_remove_this_node_from"),
        attr: { title: note?.summary ?? t("ui.the_file_was_moved_or_deleted_you_can_remove_this_node_from") }
      });
    if (errorDetails.length) {
      const error = card.createEl("p", { cls: "vam-card-error", text: errorDetails[0] });
      error.setAttr("title", errorDetails.join("\n"));
    }
    if (node.aimKind === "conclusion" && this.map?.aim && !this.builtIn) {
      const branch = this.map.aim.branches.find(item => item.results.some(result => result.nodeId === node.id));
      const hasFollowup = this.map.nodes.some(item => item.parentId === node.id && item.aimKind === "question");
      if (
        branch &&
        !hasFollowup &&
        countAimAnsweredQuestions(this.map, branch.id) < MIN_ANSWERED_QUESTIONS_BEFORE_CONCLUSION
      ) {
        card.createEl("p", { cls: "vam-hint", text: t("ui.aim_early_conclusion_hint") });
        this.button(
          card,
          t("ui.aim_resume_early_conclusion"),
          () => void this.planAimFromSelection(node.id),
          this.aimBusy
        ).addClass("mod-cta");
      }
    }
    if (node.aimKind === "topic" && this.map?.aim && !this.map.nodes.some(item => item.aimKind === "question")) {
      const initialBranch = this.map.aim.branches.find(item => item.questionNodeId === node.id && !item.parentBranchId);
      const initialRuns = initialBranch ? this.map.aim.runs.filter(item => item.branchId === initialBranch.id) : [];
      const activeInitialRun = initialRuns.some(run => {
        const attempt = run.attempts.find(item => item.id === run.currentAttemptId);
        return attempt?.status === "running" || attempt?.status === "saving";
      });
      const terminalResult = initialBranch
        ? [...initialBranch.results].reverse().find(result => result.kind !== "research")
        : undefined;
      const terminalRun = terminalResult ? initialRuns.find(item => item.id === terminalResult.runId) : undefined;
      const terminalAttempt =
        terminalResult && terminalRun
          ? terminalRun.attempts.find(item => item.id === terminalResult.attemptId)
          : undefined;
      if (!initialBranch) {
        const start = this.button(
          card,
          t("ui.aim_start_exploration"),
          () => {
            void this.planAimFromSelection(node.id);
          },
          this.aimBusy
        );
        start.addClass("mod-cta");
        start.addClass("vam-aim-start");
      } else if (!activeInitialRun && terminalAttempt?.status === "partial" && terminalRun) {
        this.button(
          card,
          t("ui.aim_continue_research"),
          () => void this.continueAimResearch(node.id, terminalRun.id),
          this.aimBusy
        ).addClass("vam-aim-retry");
      } else if (!activeInitialRun && !terminalResult) {
        this.renderAimFailure(card, initialBranch);
        const label =
          initialBranch.researchPlan || initialBranch.results.length
            ? t("ui.aim_continue_research")
            : t("ui.aim_retry_subtopics");
        this.button(card, label, () => void this.retryAimSubtopics(initialBranch.id), this.aimBusy).addClass(
          "vam-aim-retry"
        );
      }
    }
    if (node.aimKind === "question" && this.map?.aim) {
      const branch = this.map.aim.branches.find(item => item.questionNodeId === node.id);
      if (branch) {
        this.renderAimFailure(card, branch);
        const labels =
          node.aimQuestion?.options
            .filter(option => branch.answerSnapshot.selections.includes(option.id))
            .map(option => option.label) ?? branch.answerSnapshot.selections;
        const answer = [...labels, branch.answerSnapshot.freeText].filter(Boolean).join(" — ");
        card.createEl("p", {
          cls: "vam-aim-answer-snapshot",
          text: `${t("ui.aim_answer_snapshot")}: ${answer || t("ui.aim_unknown_answer")}`
        });
        const branchRuns = this.map.aim.runs.filter(item => item.branchId === branch.id);
        const activeBranchRun = branchRuns.some(run => {
          const current = run.attempts.find(item => item.id === run.currentAttemptId);
          return current?.status === "running" || current?.status === "saving";
        });
        const terminalResult = [...branch.results].reverse().find(result => result.kind !== "research");
        const terminalRun = terminalResult && branchRuns.find(item => item.id === terminalResult.runId);
        const terminalAttempt = terminalRun?.attempts.find(item => item.id === terminalResult?.attemptId);
        if (!activeBranchRun && terminalAttempt?.status === "partial" && terminalRun) {
          this.button(
            card,
            t("ui.aim_continue_research"),
            () => void this.continueAimResearch(node.id, terminalRun.id),
            this.aimBusy
          ).addClass("vam-aim-retry");
        }
        if (!branch.researchPlan && branch.results.length === 0) {
          const status = card.createEl("p", {
            cls: "vam-aim-plan-error",
            text: t("ui.aim_research_not_generated")
          });
          if (branch.researchPlanError) status.setAttr("title", branch.researchPlanError);
          if (!activeBranchRun && !terminalResult) {
            const retry = this.button(card, t("ui.aim_retry_subtopics"), () => void this.retryAimSubtopics(branch.id));
            retry.addClass("vam-aim-retry");
            retry.disabled = this.aimBusy;
          }
        } else if (!activeBranchRun && !terminalResult) {
          this.button(
            card,
            t(branch.deliveryRecovery ? "ui.aim_resume_stage" : "ui.aim_continue_research"),
            () => void this.retryAimSubtopics(branch.id),
            this.aimBusy
          ).addClass("vam-aim-retry");
        }
      }
    }
    if (node.aimKind === "answer" && this.map?.aim) {
      const branch = this.map.aim.branches.find(item => item.answerNodeId === node.id);
      const question = branch && this.map.nodes.find(item => item.id === branch.questionNodeId);
      if (branch) {
        const labels =
          question?.aimQuestion?.options
            .filter(option => branch.answerSnapshot.selections.includes(option.id))
            .map(option => option.label) ?? branch.answerSnapshot.selections;
        const answer = [...labels, branch.answerSnapshot.freeText].filter(Boolean).join(" — ");
        card.createEl("p", {
          cls: "vam-aim-answer-snapshot",
          text: `${t("ui.aim_answer_snapshot")}: ${answer || t("ui.aim_unknown_answer")}`
        });
      }
    }
    if (!this.builtIn) this.enableDrag(card, node);
    else card.addClass("is-readonly");
    if (!this.builtIn && !this.integrationMode && !this.presentation && !this.map?.aim && !node.aimKind)
      this.attachResizeHandle(card, node);
    card.addEventListener("click", event => {
      if (Date.now() < this.suppressClickUntil) return;
      if ((event.target as Element).closest("button")) return;
      // Outside selection mode, Cmd/Ctrl+click is handled on pointerup (enableDrag); inside it a click just toggles.
      if ((event.metaKey || event.ctrlKey) && !this.integrationMode) return;
      if (this.integrationMode) {
        if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id);
        else this.multiSelected.add(node.id);
        this.commitSelection(this.selected, this.selected, [node.id]);
        return;
      }
      // A click selects; an already open details sidebar follows the selection, a closed one stays closed.
      if (this.builtIn) this.selectSampleNode(node.id);
      else {
        this.selectMapNode(node);
        if (this.plugin.detailsShown()) this.openDetails(node);
      }
    });
    card.addEventListener("keydown", event => {
      if (event.target !== card) return;
      const target = this.keyboardNeighbor(node, event.key);
      if (target) {
        event.preventDefault();
        this.moveKeyboardFocus(target);
        return;
      }
      const editable = !this.builtIn && !this.integrationMode && !this.map?.aim;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      if (editable && !event.isComposing) {
        if (plain && !event.shiftKey && (event.key === "Delete" || event.key === "Backspace")) {
          event.preventDefault();
          this.removeByKey(node);
          return;
        }
        // Tab stays native: it walks into the card's tools, which have no other keyboard route (collapse, links, AI).
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
          if (event.defaultPrevented) return; // the view scope already added the subtopic
          event.preventDefault();
          this.enqueue(() => this.addNode(node));
          return;
        }
        if (event.key === "Enter" && event.shiftKey && plain) {
          if (event.defaultPrevented) return; // the view scope already added the sibling
          event.preventDefault();
          const parent = this.map?.nodes.find(item => item.id === node.parentId) ?? null;
          this.enqueue(() => this.addNode(parent));
          return;
        }
      }
      if (event.key === "F2" && note && !this.builtIn && !this.integrationMode && !this.map?.aim) {
        if (event.defaultPrevented) return; // the view scope already handled this F2
        event.preventDefault();
        this.renameNode(node, note.title);
        return;
      }
      if (event.key === "Enter") {
        if (this.integrationMode) {
          if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id);
          else this.multiSelected.add(node.id);
          this.commitSelection(this.selected, this.selected, [node.id]);
        } else if (this.builtIn) this.selectSampleNode(node.id);
        else {
          this.selectMapNode(node);
          if (node.aimKind === "question") this.openAimAnswer(node);
          else this.openDetails(node);
        }
      }
    });
    card.addEventListener("mouseenter", () => {
      if (!note || this.integrationMode || this.dragging) return;
      this.clearHoverTimer();
      this.hoverTimer = window.setTimeout(() => {
        if (!this.dragging && card.isConnected) this.showHoverCard(card, note);
      }, 700);
    });
    card.addEventListener("mouseleave", () => this.hideHoverCardSoon());
    // Keyboard users reach the hover preview by focusing a card; its tools join the tab order only while it is focused.
    const toolButtons = (): HTMLElement[] => Array.from(card.querySelectorAll<HTMLElement>("button, .vam-card-resize"));
    card.addEventListener("focusin", event => {
      for (const button of toolButtons()) button.tabIndex = 0;
      if (
        this.restoringFocus ||
        event.target !== card ||
        !note ||
        this.integrationMode ||
        !card.matches(":focus-visible")
      )
        return;
      this.clearHoverTimer();
      this.hoverTimer = window.setTimeout(() => {
        if (card.isConnected && card.matches(":focus")) this.showHoverCard(card, note);
      }, 700);
    });
    card.addEventListener("focusout", event => {
      if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
      for (const button of toolButtons()) button.tabIndex = -1;
      this.hideHoverCardSoon();
    });
    this.fitKindShape(card, kind);
  }
  /**
   * Sizes an SVG-shaped card's padding so its text sits inside the shape: the side padding comes from the width, then the
   * text block is measured and the top and bottom padding follow its height. The card then grows with its text, and
   * dragging, arranging and the relation lines read its real height. A card that is not laid out yet (a hidden pane) is
   * left with the stylesheet's fallback padding and fitted by the next resize.
   */
  private fitKindShape(card: HTMLElement, kind: TopicKind): void {
    if (!hasSvgShape(kind)) return;
    const width = card.offsetWidth;
    if (!width) return;
    const sides = shapeInsets(kind, { width, height: 0 });
    card.style.padding = `0 ${sides.right}px 0 ${sides.left}px`;
    const height = card.clientHeight;
    const insets = shapeInsets(kind, { width, height });
    card.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }
  private fitKindShapes(): void {
    if (!this.stageEl) return;
    for (const node of this.map?.nodes ?? []) {
      const card = this.cardEls.get(node.id);
      if (card) this.fitKindShape(card, this.topicKindOf(node.id));
    }
  }
  /** What the canvas draws: visible nodes minus interim AIM results already superseded by their run's conclusion. */
  private canvasNodes(): MapNode[] {
    if (!this.map) return [];
    const superseded = supersededAimNodeIds(this.map);
    const shown = visibleNodes(this.map.nodes);
    const nodes = superseded.size ? shown.filter(node => !superseded.has(node.id)) : shown;
    // A view only: these copies carry display positions and must never be written back to the map.
    return this.relevanceSortOn()
      ? relevanceDisplayNodes(nodes, id => this.notes.get(id)?.relevance?.tier, superseded, layoutOf(this.map))
      : nodes;
  }
  /** Arrow keys walk the tree: left to the parent, right to the first child, up/down among siblings. */
  private keyboardNeighbor(node: MapNode, key: string): MapNode | undefined {
    const target = this.displayedNeighbor(node, key);
    // The walk follows the displayed order; hand back the real node so nothing downstream sees display coordinates.
    return target && (this.map?.nodes.find(item => item.id === target.id) ?? target);
  }
  private displayedNeighbor(node: MapNode, key: string): MapNode | undefined {
    if (!this.map || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return undefined;
    const shown = this.canvasNodes();
    const byY = (a: MapNode, b: MapNode): number => a.y - b.y || a.x - b.x;
    const byX = (a: MapNode, b: MapNode): number => a.x - b.x || a.y - b.y;
    // Cards in a branch with its own arrangement follow that arrangement's keys; timeline, radial and fishbone follow the right map's.
    const direction = layoutDirectionFor(this.map.nodes, node.id, layoutOf(this.map).direction) as LayoutKind;
    const byId = new Map(shown.map(item => [item.id, item]));
    // In a balanced map a card's half is the half of its first-level topic; the root has none.
    const sideOf = (card: MapNode): NavigationSide => {
      if (!card.parentId) return "root";
      let top = card;
      for (let guard = 0; top.parentId && guard < 10000; guard++) {
        const up = byId.get(top.parentId);
        if (!up?.parentId) break;
        top = up;
      }
      const root = byId.get(top.parentId ?? "");
      return root && top.x < root.x ? "left" : "right";
    };
    const move = neighborKey(direction, key, direction === "balanced" ? sideOf(node) : undefined);
    const vertical = direction === "down" || direction === "up";
    const order = vertical ? byX : byY;
    const kids = shown.filter(item => item.parentId === node.id).sort(order);
    if (move === "parent") return shown.find(item => item.id === node.parentId);
    if (move === "child") return kids[0];
    if (move === "child-left" || move === "child-right") {
      const root = byId.get(node.id) ?? node;
      return shown
        .filter(item => item.parentId === node.id && item.x < root.x === (move === "child-left"))
        .sort(byY)[0];
    }
    let siblings = shown.filter(item => (item.parentId ?? null) === (node.parentId ?? null));
    // A balanced root keeps each half's topics in their own walk.
    if (direction === "balanced" && node.parentId && !byId.get(node.parentId)?.parentId) {
      const mine = sideOf(node);
      siblings = siblings.filter(item => sideOf(item) === mine);
    }
    siblings.sort(order);
    const index = siblings.findIndex(item => item.id === node.id);
    return move === "sibling-" ? siblings[index - 1] : move === "sibling+" ? siblings[index + 1] : undefined;
  }
  private moveKeyboardFocus(target: MapNode): void {
    const card =
      this.cardEls.get(target.id) ??
      this.stageEl?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(target.id)}"]`);
    const view = this.viewportEl?.getBoundingClientRect(),
      rect = card?.getBoundingClientRect();
    if (
      view &&
      rect &&
      (rect.left < view.left || rect.right > view.right || rect.top < view.top || rect.bottom > view.bottom)
    )
      this.focusNode(target, false);
    if (this.builtIn) {
      this.focusNodeId = target.id;
      this.selectSampleNode(target.id);
      this.focusNodeId = null;
      return;
    }
    if (this.integrationMode) {
      // Topic selection mode: moving focus must not clear the topics already ticked.
      const previous = this.tabStopId;
      this.tabStopId = target.id;
      this.paintCards([previous, target.id]);
    } else {
      // A full render (AIM) rebuilds every card and restores focus to focusNodeId, so name the target first.
      this.focusNodeId = target.id;
      try {
        this.selectMapNode(target);
      } finally {
        this.focusNodeId = null;
      }
    }
    (this.cardEls.get(target.id) ?? card)?.focus({ preventScroll: true });
  }
  /** The tab stop when nothing moved it: the selected card, else the first root, else the first card. */
  private defaultTabStop(shown: MapNode[]): string | null {
    return (
      (this.selected && shown.some(node => node.id === this.selected) ? this.selected : null) ??
      shown.find(node => !node.parentId)?.id ??
      shown[0]?.id ??
      null
    );
  }
  /** Nesting level of a topic, 1 for a root; guards against a corrupt parent cycle. */
  private nodeDepth(node: MapNode): number {
    let depth = 1;
    const seen = new Set([node.id]);
    for (let parent = node.parentId; parent; depth++) {
      if (seen.has(parent)) break;
      seen.add(parent);
      parent = this.map?.nodes.find(item => item.id === parent)?.parentId ?? null;
    }
    return depth;
  }
  /** Repaints only the named cards from the current selection state (class, aria-selected, roving tabindex, checkbox). */
  private paintCards(ids: Iterable<string | null>): void {
    for (const id of new Set(ids)) {
      const card = id ? this.cardEls.get(id) : undefined;
      if (!id || !card) continue;
      const on = id === this.selected || this.multiSelected.has(id);
      card.toggleClass("is-selected", on);
      card.setAttr("aria-selected", String(on));
      card.tabIndex = id === this.tabStopId ? 0 : -1;
      const check = this.cardChecks.get(id);
      if (check) check.checked = this.multiSelected.has(id);
    }
    this.chat?.refreshSelection();
    this.syncRelationClasses();
  }
  /**
   * Moves the selection without rebuilding the map: only the previous and next cards, the changed multi-select
   * cards and the two tab stops are repainted, and the selection bar is refreshed in selection mode.
   */
  applySelectionState(prevId: string | null, nextId: string | null, touched: Iterable<string> = []): void {
    // Picking, clearing or extending the topic selection ends a line selection.
    this.selectedRelation = null;
    const previousStop = this.tabStopId;
    this.tabStopId = this.defaultTabStop(this.map ? this.canvasNodes() : []);
    this.paintCards([prevId, nextId, previousStop, this.tabStopId, ...touched]);
    if (this.integrationMode && this.selectionBarEl?.isConnected) {
      const workspace = this.selectionBarEl.parentElement;
      if (workspace) {
        const bar = this.renderSelectionBar(workspace);
        this.selectionBarEl.replaceWith(bar);
        this.selectionBarEl = bar;
      }
    }
    this.syncOutlineActive(nextId);
  }
  /** The outline highlights the selected topic; with no selection it falls back to the opened note. */
  private syncOutlineActive(nextId: string | null): void {
    const selected = nextId ? this.map?.nodes.find(node => node.id === nextId)?.path : undefined;
    this.plugin.setOutlineActive(selected ?? this.app?.workspace?.getActiveFile?.()?.path ?? "");
  }
  /** Selection changed: repaint in place, or render fully where selection also drives other chrome (AIM, sample). */
  private commitSelection(prevId: string | null, nextId: string | null, touched: Iterable<string> = []): void {
    if (this.map?.aim || this.builtIn || !this.cardEls.size) {
      this.render();
      this.syncOutlineActive(nextId);
      return;
    }
    this.applySelectionState(prevId, nextId, touched);
  }
  private clearHoverTimer(): void {
    if (this.hoverTimer !== null) window.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }
  /** A topic waiting in a batch (multi-topic or shallow research) for a free slot; it is not running yet. */
  private isResearchQueued(node: MapNode): boolean {
    return !this.plugin.running?.has(node.path) && !!this.plugin.expansionCoordinator?.isQueued(node.path);
  }
  /** Hypothesis and evidence features exist on ordinary maps only: not the built-in sample, not AIM. */
  private relationsEnabled(): boolean {
    return !this.builtIn && !!this.map && !this.map.aim;
  }
  private isHypothesis(id: string): boolean {
    return this.notes.get(id)?.topicKind === "hypothesis";
  }
  /** The type to show: only a topic on an ordinary map has one other than "topic" (AIM and the built-in sample show none). */
  private topicKindOf(id: string): TopicKind {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!this.relationsEnabled() || !node || node.aimKind) return "topic";
    return this.notes.get(id)?.topicKind ?? "topic";
  }
  /** The strength to show on a card: only a hypothesis on an ordinary map has one. */
  private hypothesisStrengthOf(id: string): HypothesisStrength | undefined {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!this.relationsEnabled() || !node || node.aimKind || !this.isHypothesis(id)) return undefined;
    return this.notes.get(id)?.hypothesisStrength ?? "weak";
  }
  private hypothesisTagText(strength: HypothesisStrength): string {
    return t("ui.hypothesis_tag_0", t(STRENGTH_LABEL[strength]));
  }
  /** The markers to show for a topic: only whitelisted ids, in the fixed order (an AIM card shows them too). */
  private markersOf(id: string): TopicMarker[] {
    const raw = this.notes.get(id)?.markers;
    return raw ? TOPIC_MARKERS.filter(marker => raw.includes(marker)) : [];
  }
  /** "Markers: Done, Star" in the language of the UI, or "" when the topic has none. */
  private markersText(markers: readonly TopicMarker[]): string {
    return markers.length
      ? t("share.viewer_markers_0", markers.map(id => t(markerLabelKey(id))).join(t("ui.list_separator")))
      : "";
  }
  /** Stops lazy loading for every cover; the next paint makes a fresh observer. */
  private releaseCovers(): void {
    this.coverObserver?.disconnect();
    this.coverObserver = null;
  }
  /**
   * Puts a fixed-height cover frame before the card's title when the note's metadata names a local image (frontmatter
   * `topic-cover`, else the first embed). Reads only the metadata cache, never the network or the note body. A missing,
   * remote or unreadable cover adds nothing. The image gets its `src` when the frame scrolls into view. Safe to call again.
   */
  private paintCover(card: HTMLElement, notePath: string): void {
    const old = cardCovers.get(card);
    if (old) {
      this.coverObserver?.unobserve(old.img);
      old.frame.remove();
      cardCovers.delete(card);
    }
    let source: string | undefined;
    try {
      const file = this.app.vault.getAbstractFileByPath(notePath);
      if (!(file instanceof TFile)) return;
      const cover = resolveCover(this.app.metadataCache.getFileCache(file), link =>
        this.app.metadataCache.getFirstLinkpathDest(link, notePath)
      );
      if (!cover || !("path" in cover)) return;
      const image = this.app.vault.getAbstractFileByPath(cover.path);
      source = image instanceof TFile ? this.app.vault.getResourcePath?.(image) : undefined;
    } catch {
      return;
    }
    if (!source) return;
    const frame = createDiv({ cls: "vam-card-cover" });
    const img = frame.createEl("img", {
      attr: { alt: "", "data-src": source, loading: "lazy", decoding: "async" }
    });
    // A file that cannot be decoded just loses its frame; the card keeps its layout of text only.
    img.addEventListener("error", () => {
      this.coverObserver?.unobserve(img);
      frame.remove();
      cardCovers.delete(card);
    });
    cardCovers.set(card, { frame, img });
    const title = card.querySelector<HTMLElement>(".vam-card-title");
    card.insertBefore(frame, title);
    if (typeof IntersectionObserver !== "function") {
      img.setAttr("src", source);
      return;
    }
    this.coverObserver ??= new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLImageElement;
        const real = target.getAttribute("data-src");
        if (real) target.setAttr("src", real);
        this.coverObserver?.unobserve(target);
      }
    });
    this.coverObserver.observe(img);
  }
  /**
   * A quiet tag with the model name on a card whose model is its own (set by hand, or inherited from a manual ancestor).
   * Never for a card that follows the current model, so switching the current model changes no tag. Safe to call again.
   */
  private paintModelTag(card: HTMLElement, header: HTMLElement, note: Note | undefined): void {
    const old = cardModelTags.get(header);
    cardModelTags.delete(header);
    const previous = card.dataset.modelText ?? "";
    // The accessible name is the card label (aria-labelledby), so the model part is merged into it and replaced on a redraw.
    let named = cardLabels.get(card)?.textContent;
    if (named && previous && named.includes(previous)) {
      const stripped = named.replace(t("ui.topic_card_label_0_1", "", previous), "");
      named = stripped === named ? named.replace(previous, "") : stripped;
    }
    if (note?.modelOverride) {
      const label = this.plugin.modelLabel(note.model),
        text = t("ui.card_model_override_0", label),
        tag = header.createSpan({ cls: "vam-node-model-tag", text: label });
      // The card name already carries the text, so the tag itself is hidden from screen readers (no second reading).
      tag.setAttr("aria-hidden", "true");
      tag.setAttr("title", text);
      // In place on a redraw; otherwise right after the marker row (painted first), so renderNode and refreshCard agree.
      const row = cardMarkerRows.get(card);
      if (old) old.replaceWith(tag);
      else if (row && row.parentElement === header) row.after(tag);
      cardModelTags.set(header, tag);
      card.dataset.modelText = text;
      if (named) this.labelCard(card, t("ui.topic_card_label_0_1", named, text));
    } else {
      old?.remove();
      delete card.dataset.modelText;
      if (named) this.labelCard(card, named);
    }
  }
  /**
   * Draws the marker symbols in the card header (aria-hidden: decoration) and adds their names to the card's accessible
   * name. Safe to call again: the old symbols and the old name part are replaced.
   */
  private paintCardMarkers(card: HTMLElement, header: HTMLElement, id: string): void {
    const old = cardMarkerRows.get(card);
    cardMarkerRows.delete(card);
    const markers = this.markersOf(id),
      text = this.markersText(markers),
      previous = card.dataset.markerText ?? "";
    let named = cardLabels.get(card)?.textContent;
    if (named && previous && named.includes(previous)) {
      const stripped = named.replace(t("ui.topic_card_label_0_1", "", previous), "");
      named = stripped === named ? named.replace(previous, "") : stripped;
    }
    if (markers.length) {
      // After the type tag on a first draw; a redraw puts the new row where the old one was.
      const kindTag = old ? null : header.querySelector(".vam-hypothesis-tag");
      const row = header.createSpan("vam-card-markers vam-hypothesis-tag");
      if (old) old.replaceWith(row);
      else if (kindTag) kindTag.after(row);
      row.setAttr("aria-hidden", "true");
      cardMarkerRows.set(card, row);
      for (const marker of markers) {
        const mark = row.createSpan({ cls: "vam-marker", text: markerSymbol(marker) });
        mark.dataset.marker = marker;
      }
      card.dataset.markerText = text;
    } else {
      old?.remove();
      delete card.dataset.markerText;
    }
    if (named) this.labelCard(card, text ? t("ui.topic_card_label_0_1", named, text) : named);
  }
  /**
   * Sets `data-topic-color` (only a whitelisted id; the value is never copied from the note as it is) and adds "Color: Red"
   * to the card's accessible name, like the marker and model parts: the old part is taken out first, so a redraw replaces
   * it in place and never doubles it. An AIM card has its own look and shows no topic colour. Safe to call again.
   */
  private paintCardColor(card: HTMLElement, note: Note | undefined, aim: boolean): void {
    const previous = card.dataset.colorText ?? "";
    let named = cardLabels.get(card)?.textContent;
    if (named && previous && named.includes(previous)) {
      const stripped = named.replace(t("ui.topic_card_label_0_1", "", previous), "");
      named = stripped === named ? named.replace(previous, "") : stripped;
    }
    const id = aim ? undefined : TOPIC_COLORS.find(color => color === note?.color);
    if (id) {
      const text = t("share.viewer_color_0", t(colorLabelKey(id)));
      card.dataset.topicColor = id;
      card.dataset.colorText = text;
      if (named) this.labelCard(card, t("ui.topic_card_label_0_1", named, text));
    } else {
      delete card.dataset.topicColor;
      delete card.dataset.colorText;
      if (named) this.labelCard(card, named);
    }
  }
  /** Names a card for assistive tech without Obsidian showing `aria-label` as a hover tooltip beside the preview. */
  private labelCard(card: HTMLElement, text: string): void {
    let label = cardLabels.get(card);
    if (!label) {
      label = card.createSpan({ cls: "vam-card-label" });
      label.id = `vam-card-label-${++cardLabelSequence}`;
      cardLabels.set(card, label);
    }
    label.textContent = text;
    const cut = cardCutLabels.get(card);
    card.setAttr("aria-labelledby", cut ? `${label.id} ${cut.id}` : label.id);
  }
  /** Marks or unmarks a card as cut: a dashed outline and a hidden "Cut" part of its accessible name. */
  private paintCut(card: HTMLElement, id: string, cut = this.cutIds().has(id)): void {
    const existing = cardCutLabels.get(card);
    if (cut && !existing) {
      card.addClass("is-cut");
      const part = card.createSpan({ cls: "vam-card-label", text: t("ui.clipboard_cut_mark") });
      part.id = `vam-card-cut-${++cardLabelSequence}`;
      cardCutLabels.set(card, part);
      const label = cardLabels.get(card);
      if (label) card.setAttr("aria-labelledby", `${label.id} ${part.id}`);
    } else if (!cut && existing) {
      card.removeClass("is-cut");
      existing.remove();
      cardCutLabels.delete(card);
      const label = cardLabels.get(card);
      if (label) card.setAttr("aria-labelledby", label.id);
    }
  }
  /** The topics of a pending cut that belongs to this map. */
  private cutIds(): Set<string> {
    const record = sessionFor(this.plugin).get();
    return record?.mode === "cut" && record.sourceMapPath === this.path ? new Set(record.nodeIds) : new Set();
  }
  private paintCutMarks(): void {
    const cut = this.cutIds();
    for (const [id, card] of this.cardEls) this.paintCut(card, id, cut.has(id));
  }
  /** Repaints the cut marks of this view and of every other map view, in the main window and in popout windows. */
  private refreshCutMarks(): void {
    this.paintCutMarks();
    for (const leaf of this.app.workspace?.getLeavesOfType?.(VIEW_TYPE) ?? []) {
      const view = leaf.view;
      if (view instanceof VisualAgentMapView && view !== this) view.paintCutMarks();
    }
  }
  /** What the share dialog may read: a snapshot of the open map, or the reason it cannot be shared. */
  shareSnapshot():
    | { map: MapDocument; notes: Map<string, Note>; goal?: string; mapPath: string }
    | "none"
    | "sample"
    | "aim"
    | "empty" {
    if (this.builtIn) return "sample";
    if (!this.map || !this.path) return "none";
    if (this.map.aim || this.map.nodes.some(node => node.aimKind !== undefined)) return "aim";
    if (!this.map.nodes.length) return "empty";
    return {
      map: JSON.parse(JSON.stringify(this.map)) as MapDocument,
      notes: new Map(this.notes),
      ...(this.relevanceGoal ? { goal: this.relevanceGoal } : {}),
      mapPath: this.path
    };
  }
  hasPath(path: string): boolean {
    return !!this.map?.nodes.some(item => item.path === path);
  }
  /**
   * Brings an outline topic into view: expands collapsed ancestors, centers the card and selects it.
   * Multi-select keeps its selection; the outline only moves the camera there. False when the map lacks the topic.
   */
  async revealPath(path: string): Promise<boolean> {
    const node = this.map?.nodes.find(item => item.path === path);
    if (!this.map || !node) return false;
    const collapsed: string[] = [];
    for (let parent = node.parentId; parent;) {
      const ancestor = this.map.nodes.find(item => item.id === parent);
      if (!ancestor) break;
      if (ancestor.collapsed) collapsed.push(ancestor.id);
      parent = ancestor.parentId;
    }
    // The sample map is never saved, so its ancestors open in memory; a real map records the change.
    if (collapsed.length && this.builtIn) {
      for (const item of this.map.nodes) if (collapsed.includes(item.id)) item.collapsed = false;
    } else if (collapsed.length) {
      await this.plugin.mutate(() =>
        this.mapChange(map => {
          for (const item of map.nodes) if (collapsed.includes(item.id)) item.collapsed = false;
        })
      );
    }
    const current = this.map?.nodes.find(item => item.id === node.id);
    if (!current) return false;
    if (!this.integrationMode) {
      const previous = this.selected,
        touched = [...this.multiSelected];
      this.selected = current.id;
      this.multiSelected.clear();
      // Opening collapsed ancestors already rendered; a plain reveal only moves the selection.
      if (collapsed.length) this.render();
      else this.commitSelection(previous, current.id, touched);
    } else this.render();
    this.focusNode(current);
    return true;
  }
  private selectSampleNode(id: string): void {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!node) return;
    this.selected = id;
    this.render();
    this.focusNode(node);
  }
  private selectMapNode(node: MapNode): void {
    if (this.selected === node.id && this.multiSelected.size === 0) return;
    const previous = this.selected,
      touched = [...this.multiSelected];
    this.selected = node.id;
    this.multiSelected.clear();
    this.commitSelection(previous, node.id, touched);
  }
  private hideHoverCardSoon(): void {
    this.clearHoverTimer();
    this.hoverTimer = window.setTimeout(() => {
      this.hoverCard?.remove();
      this.hoverCard = null;
      this.hoverTimer = null;
    }, 220);
  }
  private showHoverCard(card: HTMLElement, note: Note): void {
    if (this.presentation) return;
    // The card is placed against the canvas, not the whole row: the chat window beside it is not part of the map.
    const workspace = this.contentEl.querySelector<HTMLElement>(".vam-canvas");
    if (!workspace) return;
    this.hoverCard?.remove();
    const preview = workspace.createDiv("vam-hover-card");
    this.hoverCard = preview;
    const size = previewMetrics(this.plugin.settings.previewScale);
    preview.style.maxHeight = `${size.height}px`;
    preview.style.setProperty("--vam-hover-image-max", size.image);
    preview.style.setProperty("--vam-hover-title-size", size.title);
    preview.style.setProperty("--vam-hover-body-size", size.body);
    preview.style.setProperty("--vam-hover-label-size", size.labelSize);
    preview.style.setProperty("--vam-hover-table-size", size.table);
    preview.style.setProperty("--vam-hover-line-height", size.line);
    preview.style.setProperty("--vam-hover-padding", size.padding);
    preview.addEventListener("mouseenter", () => this.clearHoverTimer());
    preview.addEventListener("mouseleave", () => this.hideHoverCardSoon());
    preview.createEl("strong", { text: note.title });
    const path = this.map?.nodes.find(node => node.id === card.dataset.nodeId)?.path ?? "";
    // Only while a run is in flight on this topic (its block is hidden until there is something to show).
    this.hoverResearch = null;
    if (this.plugin.researchProgress?.get(path)) {
      const research = preview.createDiv("vam-hover-research-preview");
      research.createDiv({ cls: "vam-hover-label", text: t("ui.research_preview_label") });
      this.hoverResearch = {
        path,
        block: research,
        summary: research.createDiv("vam-hover-research-summary"),
        detail: research.createDiv("vam-hover-research-detail")
      };
      this.paintHoverResearch();
    }
    const content = preview.createDiv("vam-hover-markdown");
    void MarkdownRenderer.render(this.app, note.preview || t("ui.no_preview_content_yet"), content, path, this);
    const host = workspace.getBoundingClientRect(),
      rect = card.getBoundingClientRect();
    const availableWidth = Math.max(180, host.width - 24);
    const width = Math.min(size.max, Math.max(Math.min(size.min, availableWidth), availableWidth));
    preview.style.width = `${width}px`;
    let left = rect.right - host.left + 12;
    if (left + width > host.width - 12) left = rect.left - host.left - width - 12;
    const visibleHeight = Math.min(size.height, Math.max(180, host.height - 24));
    const maxTop = Math.max(12, host.height - visibleHeight - 12);
    preview.style.left = `${Math.max(12, Math.min(left, Math.max(12, host.width - width - 12)))}px`;
    preview.style.top = `${Math.max(12, Math.min(rect.top - host.top, maxTop))}px`;
  }
  private refreshCard(node: MapNode, redrawEdges = true): void {
    const card = this.stageEl?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(node.id)}"]`),
      note = this.notes.get(node.id);
    if (!card || !note) return;
    const title = card.querySelector<HTMLElement>(".vam-card-title");
    title?.setAttr("title", note.title);
    title?.setText(note.title);
    // Same summary rule as renderNode: a placeholder summary is not shown.
    let summary = card.querySelector<HTMLElement>(".vam-card-summary");
    if (isPlaceholder(note.summary)) summary?.remove();
    else {
      if (!summary && title) {
        summary = createEl("p", { cls: "vam-card-summary" });
        title.after(summary);
      }
      summary?.setText(note.summary);
      summary?.setAttr("title", note.summary);
      summary?.removeClass("is-preview");
    }
    const header = card.querySelector<HTMLElement>(".vam-node-header");
    const status = card.querySelector<HTMLElement>(".vam-node-header > .vam-status:not(.vam-aim-question-status)");
    if (node.aimKind) {
      this.labelCard(card, note.title);
      if (note.status === "completed") status?.remove();
      else if (status) {
        status.className = `vam-status vam-status-${note.status}`;
        status.setText(topicStatusLabel(note.status, this.plugin.settings.language));
      } else
        header?.createSpan({
          cls: `vam-status vam-status-${note.status}`,
          text: topicStatusLabel(note.status, this.plugin.settings.language)
        });
    } else if (
      !this.isMerging(node.id) &&
      !this.plugin.running?.has(node.path) &&
      !this.plugin.quickExpandPending?.has(node.path) &&
      !this.isResearchQueued(node)
    ) {
      // A running card keeps its running frame and chip until the next full render.
      const label =
        note.status === "completed" ? t("ui.researched") : topicStatusLabel(note.status, this.plugin.settings.language);
      card.dataset.status = note.status;
      this.labelCard(card, t("ui.topic_card_label_0_1", note.title, label));
      if (note.status === "completed") status?.remove();
      else if (status) {
        status.className = `vam-status vam-status-${note.status}`;
        status.setText(label);
      } else header?.prepend(createSpan({ cls: `vam-status vam-status-${note.status}`, text: label }));
    }
    // The label above was rewritten from the title and status; a typed topic keeps its type (a hypothesis its strength) in the accessible name.
    const kind = this.topicKindOf(node.id);
    if (kind !== "topic") {
      const strength = this.hypothesisStrengthOf(node.id);
      const kindText = strength ? this.hypothesisTagText(strength) : t(TOPIC_KIND_SHAPES[kind].labelKey),
        named = cardLabels.get(card)?.textContent;
      if (named && !named.includes(kindText)) this.labelCard(card, t("ui.topic_card_label_0_1", named, kindText));
    }
    if (header) {
      this.paintCardMarkers(card, header, node.id);
      this.paintModelTag(card, header, note);
    }
    this.paintCardColor(card, note, !!node.aimKind);
    // A new title or summary changes the text's height, and the shape's padding follows it.
    this.fitKindShape(card, kind);
    if (redrawEdges) this.drawEdges();
  }
  private taskSourceSettings(
    currentLabel: string,
    currentTopicId = this.map?.id ?? "",
    synthesisLabel?: string
  ): TaskSourceSettings {
    return {
      currentTopicId,
      currentLabel,
      topics: async () =>
        Promise.all(
          (await this.plugin.repo.topics()).map(async topic => {
            const map = await this.plugin.repo.readMap(topic.mapPath);
            return {
              id: topic.id,
              title: topic.title,
              mapPath: topic.mapPath,
              nodePaths: map.nodes.map(node => node.path)
            };
          })
        ),
      readTopic: async (topic, signal, progress) => {
        const map = await this.plugin.repo.readMap(topic.mapPath);
        const files = map.nodes.map(node => {
          const file = this.app.vault.getAbstractFileByPath(node.path);
          if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md")
            throw new Error(t("ui.reference_map_note_unavailable", node.path));
          return file;
        });
        const documents: { path: string; content: string }[] = [];
        for (let index = 0; index < files.length; index += 20) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          progress(t("ui.reference_read_progress", Math.min(index + 20, files.length), files.length));
          documents.push(
            ...(await Promise.all(files.slice(index, index + 20).map(file => readMarkdownFile(this.app, file))))
          );
        }
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        return documents;
      },
      synthesisLabel
    };
  }
  /**
   * What a Next Step dialog needs to hide itself once AI starts: the card shows running and Stop from `begin` until
   * the provider accepts (`end`), and a result that arrives with the dialog closed is announced by one Notice.
   */
  private backgroundHooks(key: string, node?: MapNode): BackgroundHooks {
    let own: AbortController | undefined;
    // The map this run started on: a result that lands after a map switch belongs to that map, not the open one.
    const mapPath = this.path;
    return {
      begin: controller => {
        own = controller;
        this.startingTasks.set(key, controller);
        this.render();
      },
      end: () => {
        if (own && this.startingTasks.get(key) === own) this.startingTasks.delete(key);
        own = undefined;
        if (!this.closed) this.render();
      },
      outlineReady: outline => {
        if (!node || this.closed || this.path !== mapPath) return;
        this.quickOutlines.set(node.path, { mapPath, ...outline });
        const title = this.notes.get(node.id)?.title ?? node.path;
        const count = outlineProposals(outline.nodes).length;
        backgroundResultNotice(t("ui.background_outline_ready_0", title), {
          label: t("ui.review_outline_0", count),
          open: () => this.openNextStep(node)
        });
        this.render();
      },
      completed: (kind, result) => {
        if (!node || this.closed || this.path !== mapPath) return;
        const title = this.notes.get(node.id)?.title ?? node.path;
        if (kind === "research") {
          const view = { label: t("ui.background_view"), open: () => this.openDetails(node) };
          // A Quick answer that says the model's knowledge was not enough also offers the Standard run.
          if (result && hasKnowledgeGapMarker(result.detail))
            backgroundResultNotice(t("ui.background_research_gap_0", title), [
              view,
              {
                label: t("ui.rerun_standard"),
                open: () => {
                  // The notice outlives a map switch: the re-run belongs to the map the research ran on.
                  if (this.path !== mapPath) new Notice(t("ui.rerun_standard_other_map"));
                  else this.rerunStandard(node);
                }
              }
            ]);
          else backgroundResultNotice(t("ui.background_research_done_0", title), view);
        } else {
          const count = this.plugin.pendingSuggestions.get(node.path)?.length ?? 0;
          backgroundResultNotice(t("ui.background_expand_ready_0", title), {
            label: t("ui.view_0_expansion_suggestions", count),
            open: () => this.openNodePanel(node, "proposals")
          });
        }
      }
    };
  }
  private selectionTaskKey(): string {
    return `selection:${this.path}`;
  }
  private openNextStep(node: MapNode): void {
    this.enqueue(async () => {
      const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
      const currentLabel = t("ui.reference_current_topic_included", note.title);
      const synthesisLabel = t("ui.reference_synthesis_topics_included", note.title);
      const sources = this.taskSourceSettings(currentLabel, this.map?.id, synthesisLabel);
      sources.synthesisTopics =
        this.map?.nodes
          .filter(item => item.parentId === node.id)
          .map(item => this.notes.get(item.id)?.title ?? item.path) ?? [];
      new NextStepModal(
        this.app,
        note.title,
        this.map?.nodes.filter(item => item.parentId === node.id).length ?? 0,
        this.plugin.pendingSuggestions.get(node.path)?.length ?? 0,
        this.plugin,
        async (options, focus, done, failed, accepted) => {
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          const taskLanguage =
            options.outputLanguage ?? outputLanguageForMap(this.map, this.plugin.settings.language, latest.title);
          const task = researchTopicTask(taskLanguage, latest.title);
          const detailTemplate = await this.detailTemplateFor(node, options.detailTemplateId, options.toneId);
          await this.runAgent(
            node,
            done,
            failed,
            {
              detailTemplate,
              task: [task, options.requirements].filter(Boolean).join("\n\n"),
              referenceGroups: options.referenceGroups,
              onProgress: options.onProgress,
              signal: options.signal,
              outputLanguage: options.outputLanguage,
              rules: "",
              researchMode: options.researchMode,
              researchDepth: options.researchDepth,
              visualMode: options.visualMode,
              mapAiMode: options.mapAiMode,
              addCharts: options.mapAiMode !== "quick"
            },
            accepted,
            // The dialog's model for this run only; a pinned choice was already saved on the topic.
            options.runOnce
          );
        },
        (options, direction, found, failed, accepted) =>
          this.proposeChildren(node, options, direction, found, failed, accepted),
        (options, direction, failed, accepted, observer) =>
          this.startSynthesis(node, options, direction, failed, accepted, observer),
        {
          model: note.model,
          modelSource: note.modelSource,
          followDefault: await this.plugin.repo.followDefaultModel(node.path, this.map ?? undefined),
          reasoning: note.reasoning ?? this.plugin.settings.cliReasoning,
          rules: note.rules,
          path: node.path,
          save: patch => this.plugin.mutate(() => this.noteChange(node, patch)),
          running:
            this.plugin.running.has(node.path) ||
            this.plugin.quickExpandPending.has(node.path) ||
            this.startingTasks.has(node.path),
          stop:
            this.startingTasks.has(node.path) || this.plugin.activeTasks.has(node.path)
              ? () => (this.startingTasks.get(node.path) ?? this.plugin.activeTasks.get(node.path))?.abort()
              : undefined,
          background: this.backgroundHooks(node.path, node),
          quickOutline: this.quickOutline(node),
          pendingOutline: ((): PendingOutline | undefined => {
            const waiting = this.quickOutlines.get(node.path);
            if (!waiting || waiting.mapPath !== this.path) return undefined;
            return {
              nodes: waiting.nodes,
              dropped: waiting.dropped,
              options: waiting.options,
              discard: () => {
                if (this.quickOutlines.get(node.path) === waiting) this.quickOutlines.delete(node.path);
                if (!this.closed) this.render();
              }
            };
          })(),
          structureReview: this.nextStepStructureReview(node),
          sources,
          templates: this.templateChoices(),
          tones: this.toneChoices(),
          currentTone: this.toneLabelFor(note),
          currentStyle: this.currentStyleLabel(this.resolveTopicTemplate(note).template.id, this.effectiveToneId(note)),
          currentSummary: note.summary,
          ...(existingNoteLanguage(note) ? { contentLanguage: existingNoteLanguage(note) } : {}),
          ...this.outputLanguageMemory(),
          ...this.aiModeMemory(),
          // Only a label: a missing topic template is reported at the next AI update, not when the dialog opens.
          currentTemplate: templateInLanguage(this.resolveTopicTemplate(note).template, this.plugin.settings.language)
            .name,
          topicStatus: note.status,
          childrenCompleted:
            this.map?.nodes.filter(item => item.parentId === node.id && this.notes.get(item.id)?.status === "completed")
              .length ?? 0,
          synthesisPending: (() => {
            const pending = this.synthesisTasks.get(node.path);
            return pending?.state === "directions" && pending.mapPath === this.path
              ? { directions: pending.directions, discard: () => this.discardSynthesis(node) }
              : undefined;
          })()
        }
      ).open();
    });
  }
  private openNodePanel(node: MapNode, mode: "structure" | "proposals"): void {
    const render = (content: HTMLElement, close: () => void, host: HTMLElement): void =>
      this.renderInspector(content, node, mode, close, host);
    new (class extends Modal {
      onOpen(): void {
        this.modalEl.addClass("vam-topic-modal", "vam-review-modal");
        render(this.contentEl, () => this.close(), this.modalEl);
      }
    })(this.app).open();
  }
  private renderInspector(
    parent: HTMLElement,
    node: MapNode,
    mode: "structure" | "proposals" = "structure",
    close?: () => void,
    host?: HTMLElement
  ): void {
    // The canvas overlay makes room for the sample inspector; a class does it without a :has() selector.
    if (this.builtIn) parent.addClass("has-inspector");
    const panel = parent.createDiv(this.builtIn ? "vam-inspector" : "vam-topic-panel"),
      note = this.notes.get(node.id);
    const heading = panel.createDiv("vam-inspector-heading");
    heading.createEl("strong", {
      text: this.builtIn
        ? t("ui.sample_content")
        : mode === "structure"
          ? t("ui.structure_and_links")
          : t("ui.expansion_suggestions")
    });
    if (this.builtIn)
      this.button(heading, t("ui.close"), () => {
        this.selected = null;
        this.render();
      });
    else if (note) panel.createEl("p", { cls: "vam-inspector-topic", text: t("ui.topic_0", note.title) });
    if (note) {
      if (this.builtIn) {
        panel.createEl("h3", { text: note.title, attr: { dir: "auto" } });
        panel.createEl("p", { text: note.summary, cls: "vam-sample-summary" });
        const detail = panel.createDiv("vam-sample-detail");
        void MarkdownRenderer.render(this.app, note.detail, detail, "", this);
        if (note.sourcePaths.length) {
          const sources = panel.createDiv("vam-reference-sources");
          sources.createEl("strong", { text: t("ui.source_topics") });
          for (const path of note.sourcePaths) {
            const source = this.map?.nodes.find(item => item.path === path);
            if (source)
              this.button(sources, this.notes.get(source.id)?.title ?? path, () => this.selectSampleNode(source.id));
          }
        }
        return;
      }
      if (mode === "proposals") this.renderPendingProposals(panel, node, note, close, host);
      if (mode === "structure") {
        const sourcePaths = this.referenceSourcePaths(note, node.path);
        if (sourcePaths.length) {
          const sources = panel.createDiv("vam-reference-sources");
          sources.createEl("strong", { text: t("ui.source_topics") });
          for (const path of sourcePaths) {
            const sourceNode = this.map?.nodes.find(item => item.path === path),
              sourceNote = sourceNode ? this.notes.get(sourceNode.id) : null;
            const file = this.app.vault.getAbstractFileByPath(path);
            this.button(
              sources,
              sourceNote?.title ??
                (file instanceof TFile ? file.basename : t("ui.0_moved", path.split("/").at(-1)?.replace(/\.md$/, ""))),
              () => {
                close?.();
                if (sourceNode) {
                  this.selected = sourceNode.id;
                  this.render();
                  this.focusNode(sourceNode);
                } else if (file instanceof TFile) void this.plugin.openDetails(file);
              },
              !(sourceNode || file instanceof TFile)
            );
          }
        }
      }
    } else if (mode === "structure") {
      panel.createEl("p", { text: t("ui.this_node_s_note_is_missing_relink_an_unassigned_note_or_rem") });
      this.button(panel, t("ui.relink_note"), () =>
        this.enqueue(async () => {
          const candidates = await this.plugin.repo.collectionFiles(this.path, "Unassigned");
          new NoteCollectionModal(this.app, t("ui.relink_note"), candidates, [
            { label: t("ui.use_this_note"), run: file => this.enqueue(() => this.relinkMissingNode(node, file)) }
          ]).open();
        })
      );
    }
    if (mode !== "structure") return;
    // Order (decision 35): type and strength, relations, then the parent topic, then the footer.
    if (note) this.renderHypothesisSection(panel, node, close);
    if (note) this.renderMarkerSection(panel, node);
    if (note) this.renderColorSection(panel, node);
    if (note) this.renderCoverSection(panel, node);
    this.renderBranchLayoutSection(panel, node);
    const relationship = panel.createDiv("vam-inspector-section");
    relationship.createEl("strong", {
      text: t("ui.parent_topic"),
      cls: "vam-topic-tree-heading vam-section-heading"
    });
    // Choosing a parent moves the topic at once, one undo step (decision 40); the line under the footer says where it went.
    let currentParent = node.parentId ?? null;
    let moveTo = (_parentId: string | null): void => {};
    const parentTree = renderTopicTree(relationship, {
      nodes: this.map!.nodes,
      title: candidate => this.notes.get(candidate.id)?.title ?? candidate.path,
      label: t("ui.parent_topic_link"),
      selectable: candidate => canParent(this.map!.nodes, node.id, candidate.id),
      rootChoice: t("ui.no_parent_root_topic"),
      value: currentParent ?? "",
      onChoose: id => moveTo(id || null)
    });
    relationship.createEl("p", {
      cls: "vam-hint",
      text: t("ui.changing_the_parent_affects_context_for_the_next_ai_task_the")
    });
    const actions = (host ?? panel).createDiv("vam-next-actions");
    if (note) this.renderAddSubtopic(actions, node, close);
    const remove = actions.createEl("button", { text: t("ui.remove_from_map"), cls: "vam-discard" });
    remove.addEventListener("click", () => {
      close?.();
      this.confirmRemoveNode(node);
    });
    const status = actions.createSpan({
      cls: "vam-next-actions-note vam-next-status",
      attr: { "aria-live": "polite" }
    });
    actions.createEl("button", { text: t("ui.close") }).addEventListener("click", () => close?.());
    moveTo = parentId => {
      if (parentId === currentParent) return;
      // A merging card keeps its parent: the tree goes back to the one it has.
      if (!this.mergeUnlocked(parentId ? [node.id, parentId] : [node.id])) {
        parentTree.select(currentParent ?? "");
        return;
      }
      currentParent = parentId;
      parentTree.select(parentId ?? "");
      status.setText(
        parentId ? t("ui.moved_under_0", this.notes.get(parentId)?.title ?? "") : t("ui.became_root_topic")
      );
      this.enqueue(async () => {
        if (!this.mergeUnlocked(parentId ? [node.id, parentId] : [node.id])) return;
        await this.mapChange(map => {
          if (!canParent(map.nodes, node.id, parentId)) throw new Error(t("ui.circular_links_are_not_allowed"));
          map.nodes.find(n => n.id === node.id)!.parentId = parentId;
          const branch = new Set([node.id, ...descendants(map.nodes, node.id)]);
          const parent = parentId ? map.nodes.find(n => n.id === parentId) : undefined;
          if (parent) {
            parent.collapsed = false;
            map.nodes = arrangeNewBranch(map.nodes, parent.id, branch, this.cardHeightOf, undefined, layoutOf(map));
          } else map.nodes = arrangeNewTree(map.nodes, node.id, branch, this.cardHeightOf, layoutOf(map));
        });
      });
    };
  }
  private renderPendingProposals(
    panel: HTMLElement,
    node: MapNode,
    note: Note,
    close?: () => void,
    host?: HTMLElement
  ): void {
    const suggestions = this.plugin.pendingSuggestions.get(node.path);
    if (!suggestions?.length) return;
    const section = panel.createDiv("vam-inspector-proposals");
    section.createEl("p", { text: t("ui.select_and_edit_suggestions_subtopics_are_created_only_after") });
    let showCount = (_count: number): void => {};
    // Same list as the explore dialog; suggestions that name this topic as parent are first-level.
    const list = renderProposalList(section, suggestions, count => showCount(count), { rootTitle: note.title });
    const researchLabel = section.createEl("label", { cls: "vam-field vam-next-toggle" });
    const shallow = researchLabel.createEl("input", { type: "checkbox" });
    shallow.checked = !!this.plugin.pendingResearchOptions.get(node.path)?.shallowResearch;
    researchLabel.createSpan({ text: t("ui.run_shallow_research_on_each_created_subtopic") });
    const actions = (host ?? section).createDiv("vam-next-actions");
    const discard = actions.createEl("button", { text: t("ui.discard_these_suggestions"), cls: "vam-discard" });
    const status = actions.createSpan({
      cls: "vam-next-actions-note vam-next-status",
      attr: { "aria-live": "polite" }
    });
    actions.createEl("button", { text: t("ui.close") }).addEventListener("click", () => close?.());
    const create = actions.createEl("button", { text: t("ui.create_0_subtopics", list.count()), cls: "mod-cta" });
    showCount = count => {
      create.setText(t("ui.create_0_subtopics", count));
      create.disabled = count === 0;
      status.setText("");
    };
    create.addEventListener("click", () => {
      void (async () => {
        if (this.plugin.expansionCoordinator.isRunning(node.path)) {
          status.setText(t("ui.ai_running_ai"));
          return;
        }
        const items = list.selected();
        if (typeof items === "string") {
          status.setText(items);
          return;
        }
        create.disabled = true;
        status.setText(t("ui.creating_subtopics"));
        try {
          let createdNodes: MapNode[] = [];
          const researchOptions: TaskOptions | undefined = shallow.checked
            ? {
                ...(this.plugin.pendingResearchOptions.get(node.path) ?? {
                  ...aiModeOptions("quick", "subtopic"),
                  referenceGroups: []
                }),
                shallowResearch: true
              }
            : undefined;
          await this.plugin.mutate(async () => {
            const current = this.map?.nodes.find(item => item.id === node.id && item.path === node.path);
            if (!current) throw new Error(t("ui.the_topic_changed_select_it_again"));
            if (this.plugin.pendingSuggestions.get(node.path) !== suggestions)
              throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
            await this.assertSuggestionOrigin(current, suggestions);
            try {
              createdNodes = await this.createChildBatch(current, items, researchOptions);
            } catch (error) {
              if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(node.path, error);
              throw error;
            }
            this.plugin.pendingSuggestions.delete(node.path);
            this.plugin.pendingResearchOptions.delete(node.path);
            await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
          });
          if (researchOptions && createdNodes.length)
            await this.startShallowResearch(node, createdNodes, researchOptions);
          close?.();
          this.render();
        } catch (error) {
          create.disabled = false;
          status.setText(error instanceof Error ? error.message : String(error));
        }
      })();
    });
    armDiscard(
      discard,
      status,
      () =>
        void (async () => {
          try {
            await this.plugin.mutate(async () => {
              if (this.plugin.pendingSuggestions.get(node.path) !== suggestions)
                throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
              this.plugin.pendingSuggestions.delete(node.path);
              this.plugin.pendingResearchOptions.delete(node.path);
              await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
            });
            close?.();
            this.render();
          } catch (error) {
            status.setText(error instanceof Error ? error.message : String(error));
          }
        })()
    );
  }
  private async repairMissingTopic(): Promise<void> {
    const broken = await this.plugin.repo.brokenTopics();
    if (!broken.length) {
      new Notice(t("ui.no_topics_with_a_missing_map_md"));
      return;
    }
    new ChoiceModal(
      this.app,
      t("ui.repair_missing_map"),
      t("ui.choose_a_topic_to_repair"),
      broken.map(topic => ({
        label: t("ui.0_1_notes", topic.title, topic.noteCount),
        action: () => {
          new ChoiceModal(this.app, topic.title, t("ui.rebuild_a_map_from_notes_as_root_nodes_or_relink_an_existing"), [
            {
              label: t("ui.rebuild_from_notes"),
              action: () =>
                this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.rebuildMissingMap(topic.root)))
            },
            {
              label: t("ui.relink_existing_map"),
              action: () =>
                this.enqueue(async () => {
                  const candidates = (await this.plugin.repo.mapFiles()).filter(
                    file => !isManagedMapPath(this.plugin.settings, file.path)
                  );
                  new ChoiceModal(
                    this.app,
                    t("ui.choose_existing_map"),
                    t("ui.move_the_selected_map_into_this_topic_and_rebuild_node_paths"),
                    candidates.map(file => ({
                      label: file.path,
                      action: () =>
                        this.enqueue(async () =>
                          this.openMapInMutation(await this.plugin.repo.relinkMissingMap(topic.root, file.path))
                        )
                    }))
                  ).open();
                })
            }
          ]).open();
        }
      }))
    ).open();
  }
  /** Sets a hypothesis's strength: the note's frontmatter and Map.md in one undoable step (undo writes the old note text back). */
  private async changeHypothesisStrength(node: MapNode, strength: HypothesisStrength): Promise<void> {
    if (!this.map || !this.relationsEnabled() || !this.isHypothesis(node.id)) return;
    const viewport = clone(this.map.viewport);
    const entry = await this.beginMapTransaction()
      .rewriteNote(node.path, path => this.plugin.repo.writeHypothesisStrength(path, strength))
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.hypothesis_strength") });
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  /** Sets a topic's type: the note's `topic-kind` and Map.md (viewport only) in one undoable step. Id, parent and relations are not touched. */
  private async changeTopicKind(node: MapNode, kind: TopicKind): Promise<void> {
    if (!this.map || !this.relationsEnabled() || node.aimKind || this.topicKindOf(node.id) === kind) return;
    const viewport = clone(this.map.viewport);
    const entry = await this.beginMapTransaction()
      .rewriteNote(node.path, path => this.plugin.repo.writeTopicKind(path, kind))
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_type") });
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  /** Adds one relation A -> B in one undoable Map.md change; an illegal one (itself, a duplicate, a cycle for derivation or prerequisite) is refused. */
  private async addRelation(fromId: string, toId: string, kind: TopicRelationKind): Promise<void> {
    if (!this.map || !this.relationsEnabled()) return;
    await this.mapChange(map => {
      if (!relationAllowed(map.topicRelations ?? [], { kind, from: fromId, to: toId })) return;
      setTopicRelations(map, [...(map.topicRelations ?? []), { kind, from: fromId, to: toId }]);
    }, false);
  }
  /** Removes one relation in one undoable Map.md change. */
  private async removeRelation(link: TopicRelation): Promise<void> {
    if (!this.map || !this.relationsEnabled()) return;
    await this.mapChange(map => {
      setTopicRelations(
        map,
        (map.topicRelations ?? []).filter(r => relationIdentity(r) !== relationIdentity(link))
      );
    }, false);
  }
  /** The six relation kinds as a menu; `pick` gets the chosen one. */
  private openRelationKindMenu(event: MouseEvent, pick: (kind: TopicRelationKind) => void): void {
    const menu = new Menu();
    for (const kind of RELATION_KINDS)
      menu.addItem(item =>
        item
          .setTitle(t(RELATION_NAME_KEY[kind]))
          .setIcon("link")
          .onClick(() => pick(kind))
      );
    menu.showAtMouseEvent(event);
  }
  /** Opens the picker for the other end (B) of a `kind` relation that starts at `node` (A); with no legal target it only says so. */
  private chooseRelationTarget(node: MapNode, kind: TopicRelationKind, onAdded?: () => void): void {
    if (!this.map || !this.relationsEnabled()) return;
    const legal = new Set(legalRelationTargets(this.map, kind, node.id));
    if (!legal.size) {
      new Notice(t("ui.no_relation_target_0", t(RELATION_NAME_KEY[kind])));
      return;
    }
    new TopicTreeModal(
      this.app,
      t("ui.add_relation_title_0", t(RELATION_NAME_KEY[kind])),
      t("ui.add_relation_description"),
      this.map.nodes,
      target => this.notes.get(target.id)?.title ?? target.path,
      target => legal.has(target.id),
      target =>
        this.enqueue(async () => {
          await this.addRelation(node.id, target.id, kind);
          onAdded?.();
        })
    ).open();
  }
  /** The text of a panel row for `link` seen from `selfId`: "Name → B" going out, "A → Name" coming in, "Name — X" for related. */
  private relationRowText(link: TopicRelation, selfId: string): string {
    const name = t(RELATION_NAME_KEY[link.kind]),
      titleOf = (id: string): string => this.notes.get(id)?.title ?? id;
    if (link.kind === "related")
      return t("ui.relation_row_related_0_1", name, titleOf(link.from === selfId ? link.to : link.from));
    return link.from === selfId
      ? t("ui.relation_row_out_0_1", name, titleOf(link.to))
      : t("ui.relation_row_in_0_1", titleOf(link.from), name);
  }
  /** The row's visible sentence "A relation B" (T1), with this topic written "This topic"; "related" reads "This topic is related to B". With a null `selfId` (the editor) both ends are named by title. */
  private relationSentence(link: TopicRelation, selfId: string | null): string {
    const self = t("ui.relation_this_topic"),
      // English needs the lower-case form after the verb ("OTHER is derived from this topic"); Chinese has one form.
      titleOf = (id: string, object = false): string =>
        id === selfId ? (object ? t("ui.relation_this_topic_object") : self) : (this.notes.get(id)?.title ?? id);
    if (link.kind === "related")
      return selfId === null
        ? t("ui.relation_sentence_related_0_1", titleOf(link.from), titleOf(link.to))
        : t("ui.relation_sentence_related_0_1", self, titleOf(link.from === selfId ? link.to : link.from));
    return t(RELATION_SENTENCE_KEY[link.kind], titleOf(link.from), titleOf(link.to, true));
  }
  /** Opens the relation editor for `link` in a dialog (the same host as the structure panel); `onChanged` repaints the panel behind it. */
  private openRelationEditor(link: TopicRelation, onChanged?: () => void, onClosed?: () => void): void {
    if (!this.map || !this.relationsEnabled()) return;
    let saveNote = (): Promise<void> => Promise.resolve();
    const render = (content: HTMLElement, close: () => void): void => {
      saveNote = this.renderRelationEditor(content, link, close, onChanged);
    };
    new (class extends Modal {
      onOpen(): void {
        this.modalEl.addClass("vam-topic-modal", "vam-review-modal");
        render(this.contentEl, () => this.close());
      }
      onClose(): void {
        // Closing saves a changed note. Obsidian puts focus back on the button that opened the dialog, but a change
        // repainted the panel and that button is gone; once the save is done, the caller moves focus to the row's replacement.
        void saveNote().then(() => {
          if (onClosed) window.setTimeout(onClosed, 0);
        });
      }
    })(this.app).open();
  }

  /**
   * The relation editor: type (only the legal ones), reverse (not for "related"; disabled with the reason when it is
   * illegal), a one-line note, and delete. Each change is one undoable Map.md step and is written at once; the note is
   * written when the box loses focus, on Ctrl/Cmd+Enter, or when the dialog closes (decision 40). Everything the user
   * typed (the note, topic titles) is shown as text only. Returns the close-time save, settled when its write is done.
   */
  private renderRelationEditor(
    parent: HTMLElement,
    initial: TopicRelation,
    close?: () => void,
    onChanged?: () => void
  ): () => Promise<void> {
    let current: TopicRelation = { ...initial };
    const root = parent.createDiv("vam-relation-editor");
    const indexOfCurrent = (): number =>
      (this.map?.topicRelations ?? []).findIndex(r => relationIdentity(r) === relationIdentity(current));
    // Runs one change on the relation held in the map being edited; `next` returns its new form, or null to delete it.
    // A note save does not repaint the dialog, so a control the user is reaching for stays where it is.
    const apply = (next: (rel: TopicRelation) => TopicRelation | null | undefined, repaint = true): Promise<void> =>
      new Promise(done =>
        this.enqueue(async () => {
          try {
            await change(next, repaint);
          } finally {
            done();
          }
        })
      );
    const change = async (
      next: (rel: TopicRelation) => TopicRelation | null | undefined,
      repaint: boolean
    ): Promise<void> => {
      const outcome: { value?: TopicRelation | null } = {};
      if (!this.map) return;
      // The line stays selected under its new identity; a deleted one is dropped by the next draw.
      await this.mapChange(map => {
        const list = map.topicRelations ?? [],
          index = list.findIndex(r => relationIdentity(r) === relationIdentity(current));
        if (index < 0) return;
        outcome.value = next(list[index]);
        // A type or direction change is checked again on the map being edited (the same rule as the choices offered).
        const old = list[index];
        if (
          outcome.value &&
          (outcome.value.kind !== old.kind || outcome.value.from !== old.from || outcome.value.to !== old.to) &&
          !relationAllowed(list, outcome.value, index)
        )
          outcome.value = undefined;
        if (outcome.value === undefined) return;
        const updated = [...list];
        if (outcome.value) updated[index] = outcome.value;
        else updated.splice(index, 1);
        setTopicRelations(map, updated);
      }, false);
      const result = outcome.value;
      if (result === null) {
        if (this.selectedRelation === relationIdentity(current)) this.selectedRelation = null;
        this.syncRelationClasses();
        onChanged?.();
        close?.();
        return;
      }
      if (result) {
        current = result;
        this.selectedRelation = relationIdentity(current);
        this.syncRelationClasses();
      }
      if (repaint) paint();
      onChanged?.();
    };
    // The note as last written or requested; a save is asked for only when the box differs from it.
    let savedNote = initial.description;
    let noteWrite: Promise<void> = Promise.resolve();
    let saveNote = (): void => {};
    // Which control takes the keyboard focus after the next repaint (a change repaints the whole dialog).
    let refocus: "kind" | "reverse" | null = null;
    const paint = (): void => {
      root.empty();
      saveNote = () => {};
      const index = indexOfCurrent();
      root.createEl("strong", { text: t("ui.relation_editor_title"), cls: "vam-topic-tree-heading" });
      if (index < 0) {
        root.createEl("p", { text: t("ui.relation_gone") });
        return;
      }
      const relations = this.map?.topicRelations ?? [];
      // E1: the sentence "A relation B" and the line sample follow the kind and direction at once.
      const summary = root.createDiv("vam-relation-editor-summary");
      this.relationSwatch(summary, current.kind);
      summary.createSpan({
        text: this.relationSentence(current, null),
        cls: "vam-relation-sentence",
        attr: { dir: "auto" }
      });
      // E2: one field per row, label above the control.
      const field = (label: string, id: string): HTMLElement => {
        const row = root.createDiv("vam-relation-field");
        row.createEl("label", { text: label, attr: { for: id } });
        return row;
      };
      // Type: every kind is listed; one that would close a derives/prerequisite cycle is disabled, with the reason beside it (Q7).
      const kindRow = field(t("ui.relation_kind_label"), "vam-relation-kind");
      const kindSelect = kindRow.createEl("select", { cls: "dropdown vam-relation-kind" });
      kindSelect.setAttr("id", "vam-relation-kind");
      kindSelect.setAttr("aria-label", t("ui.relation_kind_label"));
      const blocked: TopicRelationKind[] = [];
      for (const kind of RELATION_KINDS) {
        const open =
          kind === current.kind || relationAllowed(relations, { kind, from: current.from, to: current.to }, index);
        if (!open) blocked.push(kind);
        const option = kindSelect.createEl("option", { text: t(RELATION_NAME_KEY[kind]), value: kind });
        if (!open) option.disabled = true;
      }
      kindSelect.value = current.kind;
      if (blocked.length) {
        const reason = kindRow.createEl("p", {
          text: t("ui.relation_kind_blocked_cycle_0", blocked.map(kind => t(RELATION_NAME_KEY[kind])).join(", ")),
          cls: "vam-relation-reason"
        });
        reason.setAttr("id", "vam-relation-kind-reason");
        kindSelect.setAttr("aria-describedby", "vam-relation-kind-reason");
      }
      kindSelect.addEventListener("change", () => {
        const kind = kindSelect.value as TopicRelationKind;
        if (kind === current.kind) return;
        refocus = "kind";
        void apply(rel => ({ ...rel, kind }));
      });
      let reverseButton: HTMLElement | null = null;
      // E3 direction: one Reverse button; "related" has no direction and no button. A reverse that would close a cycle stays visible, disabled, with the reason beside it.
      if (current.kind !== "related") {
        const directionRow = root.createDiv("vam-relation-field");
        directionRow.createSpan({ text: t("ui.relation_direction_label"), cls: "vam-relation-field-label" });
        const reversed = { kind: current.kind, from: current.to, to: current.from };
        const allowed = relationAllowed(relations, reversed, index);
        const reverse = this.button(
          directionRow,
          t("ui.relation_reverse"),
          () => {
            refocus = "reverse";
            void apply(rel => ({ ...rel, from: reversed.from, to: reversed.to }));
          },
          !allowed
        );
        reverse.addClass("vam-relation-reverse");
        reverseButton = reverse;
        if (!allowed) {
          const reason = directionRow.createEl("p", {
            text: t("ui.relation_reverse_blocked_cycle"),
            cls: "vam-relation-reason"
          });
          reason.setAttr("id", "vam-relation-reverse-reason");
          reverse.setAttr("aria-describedby", "vam-relation-reverse-reason");
        }
      }
      // Note: a multi-line box of up to 200 characters, saved as one line (line breaks become spaces); an empty one removes the key.
      const noteRow = field(t("ui.relation_description_label"), "vam-relation-description");
      const description = noteRow.createEl("textarea", { cls: "vam-relation-description" });
      description.setAttr("id", "vam-relation-description");
      description.setAttr("rows", "4");
      description.setAttr("maxlength", String(RELATION_DESCRIPTION_MAX_LENGTH));
      savedNote = relations[index].description;
      description.value = savedNote ?? "";
      description.setAttr("aria-label", t("ui.relation_description_label"));
      description.setAttr("placeholder", t("ui.relation_description_placeholder"));
      const remaining = noteRow.createDiv({ cls: "vam-relation-remaining" });
      const draft = (): string | undefined => normalizeRelationDescription(description.value);
      saveNote = (): void => {
        const text = draft();
        if (text === savedNote) return;
        savedNote = text;
        noteWrite = apply(rel => {
          const next: TopicRelation = { kind: rel.kind, from: rel.from, to: rel.to };
          if (text !== undefined) next.description = text;
          return next;
        }, false);
      };
      // E5 footer (decision 40): Delete on the left, Close on the right; nothing waits for an Apply.
      const footer = root.createDiv("vam-next-actions vam-relation-footer");
      const remove = footer.createEl("button", { text: t("ui.relation_delete"), cls: "vam-discard mod-warning" });
      remove.addEventListener("click", () => void apply(() => null));
      footer.createSpan({ cls: "vam-next-status" });
      footer.createEl("button", { text: t("ui.close") }).addEventListener("click", () => close?.());
      const refresh = (): void => {
        remaining.setText(
          t(
            "ui.relation_description_remaining_0",
            Math.max(0, RELATION_DESCRIPTION_MAX_LENGTH - description.value.length)
          )
        );
      };
      description.addEventListener("input", refresh);
      description.addEventListener("change", () => saveNote());
      // Enter adds a line break; Ctrl/Cmd+Enter saves at once.
      description.addEventListener("keydown", event => {
        if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        saveNote();
      });
      refresh();
      if (refocus) ({ kind: kindSelect, reverse: reverseButton, description })[refocus]?.focus();
      refocus = null;
    };
    paint();
    return () => {
      saveNote();
      return noteWrite;
    };
  }
  /** "Add subtopic…" (the structure dialog's footer, left of "Remove from map"): the six-type menu, then a new subtopic of that type. */
  private renderAddSubtopic(actions: HTMLElement, node: MapNode, close?: () => void): void {
    if (!this.relationsEnabled() || node.aimKind) return;
    const addChild = actions.createEl("button", { text: t("ui.add_subtopic_menu"), cls: "vam-add-subtopic" });
    addChild.addEventListener("click", event => {
      event.stopPropagation();
      this.openKindMenu(event, kind => {
        close?.();
        this.enqueue(() => this.addNode(node, undefined, true, true, kind));
      });
    });
  }
  /** One 18px swatch for a type: the card's own outline (TOPIC_KIND_SHAPES), stroked in the type's colour. */
  private kindSwatch(parent: HTMLElement, kind: TopicKind): void {
    const swatch = parent.createSpan({ cls: "vam-type-swatch" });
    swatch.setAttr("aria-hidden", "true");
    swatch.dataset.kind = kind;
    let drawn: SVGElement | undefined;
    const collector = {
      appendChild: (child: SVGElement) => {
        drawn = child;
        return child;
      }
    } as unknown as HTMLElement;
    let svg = renderShapeBackground(collector, kind) ?? drawn;
    if (!svg) {
      // A rounded or rectangular type draws no SVG on the card (its CSS frame is the shape); the swatch draws that frame.
      svg = createSvg("svg");
      svg.addClass("vam-kind-shape");
      svg.setAttribute("viewBox", "0 0 100 100");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.setAttribute("aria-hidden", "true");
      const frame = createSvg("rect");
      frame.addClass("vam-kind-outline");
      for (const [name, value] of [
        ["x", "0"],
        ["y", "0"],
        ["width", "100"],
        ["height", "100"],
        ["rx", TOPIC_KIND_SHAPES[kind].shape === "rect" ? "10" : "30"],
        ["vector-effect", "non-scaling-stroke"]
      ])
        frame.setAttribute(name, value);
      svg.appendChild(frame);
    }
    swatch.insertBefore(svg, null);
  }
  /** A 32x10 sample of a relation's line (the canvas classes and arrowheads), so a row shows which line to look for. */
  private relationSwatch(parent: HTMLElement, kind: TopicRelationKind): void {
    const svg = createSvg("svg"),
      defs = createSvg("defs"),
      id = `${this.relationMarkerId}-row${++relationSwatchSequence}`;
    svg.addClass("vam-relation-swatch");
    svg.setAttribute("viewBox", "0 0 32 10");
    svg.setAttribute("aria-hidden", "true");
    const arrow = kind === "related" ? null : `url(#${id})`;
    if (arrow) {
      defs.appendChild(this.relationMarker(id, kind === "contradicts"));
      svg.appendChild(defs);
    }
    for (const gap of kind === "derives_from" ? [false, true] : [false]) {
      const line = createSvg("path");
      line.setAttribute("d", "M 0 5 L 32 5");
      if (arrow) line.setAttribute("marker-end", arrow);
      line.addClass(gap ? "vam-relation-gap" : "vam-relation");
      if (!gap) line.addClass(`vam-relation-${kind}`);
      svg.appendChild(line);
    }
    parent.insertBefore(svg, null);
  }
  /** Markers can be edited only on an ordinary editable map: not the sample, an AIM map or the select mode. */
  private markersEditable(node: MapNode): boolean {
    return this.relationsEnabled() && !node.aimKind && !this.integrationMode;
  }
  /** The marker toggles of the topic panel: one `aria-pressed` button per marker; priority is one of three. */
  private renderMarkerSection(panel: HTMLElement, node: MapNode): void {
    if (!this.markersEditable(node)) return;
    const section = panel.createDiv("vam-inspector-section vam-marker-section");
    section.createEl("strong", { text: t("ui.topic_markers"), cls: "vam-topic-tree-heading vam-section-heading" });
    const group = section.createDiv("vam-topic-markers vam-choice-group");
    group.setAttr("role", "group");
    group.setAttr("aria-label", t("ui.topic_markers"));
    const paint = (focusId?: TopicMarker): void => {
      group.empty();
      const active = this.markersOf(node.id);
      for (const id of TOPIC_MARKERS) {
        const choice = this.button(group, t(markerLabelKey(id)), () => {
          this.enqueue(async () => {
            await this.changeTopicMarker(node, id);
            paint(id);
          });
        });
        choice.createSpan({ cls: "vam-marker", text: markerSymbol(id), attr: { "aria-hidden": "true" } });
        const on = active.includes(id);
        choice.setAttr("aria-pressed", String(on));
        if (on) choice.addClass("is-pressed");
        // Repainting replaced the button; keep the keyboard focus on the one just toggled.
        if (id === focusId) choice.focus();
      }
    };
    paint();
  }
  /** The directions this branch may take of its own: those the parse keeps (never the one opposite its parent's). */
  private branchLayoutChoices(node: MapNode): BranchDirection[] {
    const map = this.map;
    if (!map || map.aim || this.builtIn || !node.parentId) return [];
    const mapDirection = layoutOf(map).direction;
    if (!allowsBranchLayout(mapDirection)) return [];
    // Offer only what `cleanBranchLayouts` keeps: a value it would delete on parse must never be written.
    return BRANCH_DIRECTIONS.filter(direction => {
      const trial = clone(map.nodes);
      const target = trial.find(item => item.id === node.id);
      if (!target) return false;
      target.layout = { direction };
      cleanBranchLayouts(trial, mapDirection);
      return !!target.layout;
    });
  }
  /** One undo step: sets or clears this branch's own arrangement (null follows the map), then re-arranges. */
  private async changeBranchLayout(node: MapNode, direction: BranchDirection | null): Promise<void> {
    if (!this.map || this.map.aim || this.builtIn) return;
    const latest = this.map.nodes.find(item => item.id === node.id);
    if (!latest) return;
    if (direction && !this.branchLayoutChoices(latest).includes(direction)) return;
    if ((branchDirectionOf(latest) ?? null) === direction) return;
    await this.mapChange(map => {
      const current = map.nodes.find(item => item.id === node.id);
      if (!current) return;
      if (direction) current.layout = { direction };
      else delete current.layout;
      cleanBranchLayouts(map.nodes, layoutOf(map).direction);
      map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
    }, false);
  }
  /** Inspector section: how the branch under this topic is arranged (D9). Absent for a root and for radial, timeline and fishbone maps. */
  private renderBranchLayoutSection(panel: HTMLElement, node: MapNode): void {
    const choices = this.branchLayoutChoices(node);
    if (!choices.length) return;
    const section = panel.createDiv("vam-inspector-section vam-branch-layout-section");
    section.createEl("strong", { text: t("ui.branch_layout"), cls: "vam-topic-tree-heading vam-section-heading" });
    const group = section.createDiv("vam-branch-layout vam-choice-group");
    group.setAttr("role", "group");
    group.setAttr("aria-label", t("ui.branch_layout"));
    // Choosing re-reads the topic and repaints the group, as the colour menu does, so the panel need not be reopened.
    const paint = (focusDirection?: BranchDirection | null): void => {
      group.empty();
      const latest = this.map?.nodes.find(item => item.id === node.id) ?? node;
      const current = branchDirectionOf(latest) ?? null;
      const options: { direction: BranchDirection | null; label: string }[] = [
        { direction: null, label: t("ui.branch_layout_follow") },
        ...this.branchLayoutChoices(latest).map(direction => ({ direction, label: t(BRANCH_LABEL[direction]) }))
      ];
      for (const option of options) {
        const choice = this.button(group, option.label, () =>
          this.enqueue(async () => {
            await this.changeBranchLayout(node, option.direction);
            paint(option.direction);
          })
        );
        const on = option.direction === current;
        choice.setAttr("aria-pressed", String(on));
        if (on) choice.addClass("is-pressed");
        if (focusDirection !== undefined && option.direction === focusDirection) choice.focus();
      }
    };
    paint();
  }
  /** Toggles one marker: the note's `topic-markers` and Map.md (viewport only) in one undoable step. */
  private async changeTopicMarker(node: MapNode, id: TopicMarker): Promise<void> {
    if (!this.map || !this.markersEditable(node)) return;
    const viewport = clone(this.map.viewport);
    const entry = await this.beginMapTransaction()
      .rewriteNote(node.path, path => this.plugin.repo.writeTopicMarkers(path, id))
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_markers") });
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  /** The card cover switch of the topic panel: one `aria-pressed` button, pressed while the cover is turned off. */
  private renderCoverSection(panel: HTMLElement, node: MapNode): void {
    if (!this.markersEditable(node)) return;
    const section = panel.createDiv("vam-inspector-section vam-cover-section");
    section.createEl("strong", { text: t("ui.topic_cover"), cls: "vam-topic-tree-heading vam-section-heading" });
    const group = section.createDiv("vam-topic-markers vam-choice-group");
    group.setAttr("role", "group");
    group.setAttr("aria-label", t("ui.topic_cover"));
    // The metadata cache may lag behind the write, so the state after a click is tracked here.
    let off = this.topicCoverOff(node);
    const paint = (focus = false): void => {
      group.empty();
      const choice = this.button(group, t("ui.topic_cover_off"), () => {
        this.enqueue(async () => {
          if (await this.changeTopicCover(node)) off = !off;
          paint(true);
        });
      });
      choice.setAttr("aria-pressed", String(off));
      if (off) choice.addClass("is-pressed");
      if (focus) choice.focus();
    };
    paint();
  }
  /** The colour menu of the topic panel: None and six named colours as a radiogroup, plus a button that gives the branch the same colour. */
  private renderColorSection(panel: HTMLElement, node: MapNode): void {
    if (!this.markersEditable(node)) return;
    const section = panel.createDiv("vam-inspector-section vam-color-section");
    section.createEl("strong", { text: t("ui.topic_color"), cls: "vam-topic-tree-heading vam-section-heading" });
    const group = section.createDiv("vam-topic-colors vam-choice-group");
    group.setAttr("role", "radiogroup");
    group.setAttr("aria-label", t("ui.topic_color"));
    const choices: (TopicColor | null)[] = [null, ...TOPIC_COLORS];
    const current = (): TopicColor | null =>
      TOPIC_COLORS.find(color => color === this.notes.get(node.id)?.color) ?? null;
    const paint = (focusId?: TopicColor | null): void => {
      group.empty();
      const active = current();
      choices.forEach((id, index) => {
        const choice = this.button(group, id ? t(colorLabelKey(id)) : t("ui.topic_color_none"), () => {
          this.enqueue(async () => {
            await this.changeTopicColor(node, id);
            paint(id);
          });
        });
        if (id) {
          const swatch = choice.createSpan({ cls: "vam-color-swatch", attr: { "aria-hidden": "true" } });
          swatch.dataset.topicColorSwatch = id;
        }
        const on = id === active;
        choice.setAttr("role", "radio");
        choice.setAttr("aria-checked", String(on));
        if (on) choice.addClass("is-pressed");
        // One tab stop for the group; the arrow keys move and choose, as in a native radio group.
        if (!this.renderingCard) choice.tabIndex = on ? 0 : -1;
        choice.addEventListener("keydown", event => {
          const step =
            event.key === "ArrowRight" || event.key === "ArrowDown"
              ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp"
                ? -1
                : 0;
          if (!step) return;
          event.preventDefault();
          const next = (index + step + choices.length) % choices.length;
          this.enqueue(async () => {
            await this.changeTopicColor(node, choices[next]);
            paint(choices[next]);
          });
        });
        // Repainting replaced the button; keep the keyboard focus on the one just chosen.
        if (focusId !== undefined && id === focusId) choice.focus();
      });
    };
    paint();
    this.button(
      section,
      t("ui.topic_color_apply_branch"),
      () => this.enqueue(() => this.changeTopicColor(node, current(), true)),
      branchNoteIds(this.map!.nodes, node.id).length < 2
    );
  }
  /**
   * Sets (or, with null, clears) the topic colour of one topic, or of the topic and all its descendants (folded ones too),
   * in one undoable step. Only the notes whose colour really changes are written; Map.md changes only its viewport. A
   * child never inherits: a branch is just several writes in the same transaction.
   */
  private async changeTopicColor(node: MapNode, color: TopicColor | null, branch = false): Promise<void> {
    if (!this.map || !this.markersEditable(node)) return;
    const ids = branch ? branchNoteIds(this.map.nodes, node.id) : [node.id];
    const targets = ids
      .map(id => this.map!.nodes.find(item => item.id === id))
      .filter((item): item is MapNode => !!item && !item.aimKind && !!this.notes.get(item.id))
      .filter(item => (TOPIC_COLORS.find(id => id === this.notes.get(item.id)?.color) ?? null) !== color);
    if (!targets.length) return;
    const viewport = clone(this.map.viewport);
    let transaction = this.beginMapTransaction();
    for (const target of targets)
      transaction = transaction.rewriteNote(target.path, path => this.plugin.repo.writeTopicColor(path, color));
    const entry = await transaction
      .editMap(this.path, map => {
        map.viewport = clone(viewport);
      })
      .commit({ deferRebuild: true, label: t("ui.topic_color") });
    this.history.push(entry);
    await this.refreshAfterSavedChange();
  }
  /** The six-type switch, a hypothesis's strength, and the relations that start or end at this topic. */
  private renderHypothesisSection(panel: HTMLElement, node: MapNode, close?: () => void): void {
    if (!this.relationsEnabled() || node.aimKind) return;
    const section = panel.createDiv("vam-inspector-section vam-hypothesis-section");
    const body = section.createDiv("vam-hypothesis-body");
    const editByPair = new Map<string, HTMLElement>();
    let addRelationButton: HTMLElement | null = null;
    const paint = (focusStrength = false, focusKind = false, focusAdd = false): void => {
      body.empty();
      const currentKind = this.topicKindOf(node.id);
      body.createEl("strong", { text: t("ui.topic_type"), cls: "vam-topic-tree-heading vam-section-heading" });
      const kinds = body.createDiv("vam-topic-kinds vam-choice-group");
      kinds.setAttr("role", "group");
      kinds.setAttr("aria-label", t("ui.topic_type"));
      for (const option of KIND_PICKER_ORDER) {
        const choice = this.button(kinds, t(TOPIC_KIND_SHAPES[option].labelKey), () => {
          if (option === currentKind) return;
          this.enqueue(async () => {
            await this.changeTopicKind(node, option);
            paint(false, true);
          });
        });
        this.kindSwatch(choice, option);
        choice.setAttr("aria-pressed", String(option === currentKind));
        if (option === currentKind) {
          choice.addClass("is-pressed");
          // Repainting replaced the pressed button; keep the keyboard focus on the one now pressed.
          if (focusKind) choice.focus();
        }
      }
      if (currentKind === "hypothesis") {
        const current = this.notes.get(node.id)?.hypothesisStrength ?? "weak";
        body.createEl("strong", {
          text: t("ui.hypothesis_strength"),
          cls: "vam-topic-tree-heading vam-section-heading"
        });
        const group = body.createDiv("vam-hypothesis-strengths vam-choice-group");
        group.setAttr("role", "group");
        group.setAttr("aria-label", t("ui.hypothesis_strength"));
        for (const option of HYPOTHESIS_STRENGTHS) {
          const choice = this.button(group, t(STRENGTH_LABEL[option]), () => {
            if (option === current) return;
            this.enqueue(async () => {
              await this.changeHypothesisStrength(node, option);
              paint(true);
            });
          });
          choice.setAttr("aria-pressed", String(option === current));
          if (option === current) {
            choice.addClass("is-pressed");
            // Repainting replaced the pressed button; keep the keyboard focus on the one now pressed.
            if (focusStrength) choice.focus();
          }
        }
      }
      // Relations: every link that starts or ends at this topic, whatever its kind.
      editByPair.clear();
      const links = (this.map?.topicRelations ?? []).filter(r => r.from === node.id || r.to === node.id);
      body.createEl("strong", { text: t("ui.relations_heading"), cls: "vam-topic-tree-heading vam-section-heading" });
      if (links.length) {
        const list = body.createEl("ul", { cls: "vam-relation-list" });
        for (const link of links) {
          const row = list.createEl("li", { cls: "vam-relation-row" }),
            text = this.relationRowText(link, node.id),
            described = link.description ? `${text}. ${link.description}` : text;
          this.bindRelationRow(row, link, described);
          this.relationSwatch(row, link.kind);
          const label = row.createSpan({ cls: "vam-relation-title", attr: { dir: "auto" } });
          label.createSpan({
            text: this.relationSentence(link, node.id),
            cls: "vam-relation-sentence",
            attr: { dir: "auto" }
          });
          if (link.description)
            label.createSpan({ text: link.description, cls: "vam-relation-description-text", attr: { dir: "auto" } });
          const tools = row.createSpan({ cls: "vam-relation-tools" });
          const pair = relationPairKey(link.from, link.to);
          // After the editor closes, focus goes to this pair's edit button as last painted (a pair has one relation),
          // or to "Add relation…" when the relation was deleted.
          const edit = this.iconButton(tools, "pencil", t("ui.edit_relation_0", text), () =>
            this.openRelationEditor(link, paint, () => (editByPair.get(pair) ?? addRelationButton)?.focus())
          );
          editByPair.set(pair, edit);
          this.iconButton(tools, "trash-2", t("ui.remove_relation_0", text), () =>
            this.enqueue(async () => {
              await this.removeRelation(link);
              paint();
            })
          );
        }
      } else body.createEl("p", { cls: "vam-hint vam-relation-empty", text: t("ui.relations_none") });
      const addRelation = body.createEl("button", { text: t("ui.add_relation") });
      addRelationButton = addRelation;
      addRelation.addEventListener("click", event => {
        event.stopPropagation();
        this.openRelationKindMenu(event, kind =>
          this.chooseRelationTarget(node, kind, () => paint(false, false, true))
        );
      });
      // Repainting replaced the button that started the flow; a keyboard user lands back on its replacement.
      if (focusAdd) addRelation.focus();
    };
    paint();
  }
  /**
   * `focus` false leaves the camera to the caller (a batch frames the whole branch once it is laid out).
   * `keyboardFocus` also hands DOM focus to the new card; only the name dialog's save asks for it, because other
   * callers (the structure review dialog stays open) must not pull focus out from under their own UI.
   */
  private async addNode(
    parentNode: MapNode | null,
    suggestedTitle?: string,
    rebuildDerivedData = true,
    focus = true,
    kind: TopicKind = "topic",
    keyboardFocus = false
  ): Promise<void> {
    if (!this.map) return;
    const typed = kind !== "topic" && this.relationsEnabled();
    // The caller may hold a display copy (sorted by relevance); saved coordinates must come from the real node.
    const parent = (parentNode && this.map.nodes.find(item => item.id === parentNode.id)) || parentNode;
    if (!suggestedTitle?.trim()) {
      const dialogTitle = typed
        ? t("ui.add_kind_0", t(TOPIC_KIND_SHAPES[kind].labelKey))
        : parent
          ? t("ui.new_subtopic")
          : t("ui.my_core_topic");
      new NameModal(this.app, dialogTitle, "", title =>
        this.enqueue(() => this.addNode(parent, title, true, true, kind, true))
      ).open();
      return;
    }
    // One resolution: a manual ancestor's model is inherited, otherwise the current model.
    const model = parent
      ? (await this.plugin.repo.resolveTopicModel(parent.path, this.map ?? undefined)).model
      : this.plugin.currentModelChoice().model;
    if (!isManagedMapPath(this.plugin.settings, this.path)) {
      new Notice(t("ui.legacy_map_view_only"));
      return;
    }
    const node = await this.plugin.repo.createNote(
      sanitizeGeneratedTitle(suggestedTitle?.trim() ?? "").trim() ||
        (typed
          ? t("ui.new_kind_0", t(TOPIC_KIND_SHAPES[kind].labelKey))
          : parent
            ? t("ui.new_subtopic")
            : t("ui.my_core_topic")),
      model,
      this.map,
      this.path,
      parent ? "inherited" : "workspace",
      // A new topic starts in Quick mode (a research of it may still be run in Standard).
      { researchMode: "local", ...(typed ? { topicKind: kind } : {}) }
    );
    // The child is inherited: its reasoning is resolved at read time (manual ancestor, else current), never written.
    node.parentId = parent?.id ?? null;
    // Provisional spot; the real one is laid out against measured card heights inside the history entry below.
    node.x = parent ? parent.x + 340 : 80;
    node.y = parent?.y ?? 80;
    this.notes.set(
      node.id,
      await this.plugin.repo.readNote(node.path, { ...this.map, nodes: [...this.map.nodes, node] })
    );
    this.selected = node.id;
    await this.mapChangeSnapshots(
      map => {
        map.nodes.push(node);
        const owner = parent ? map.nodes.find(n => n.id === parent.id) : undefined;
        if (owner) {
          owner.collapsed = false;
          // A new sibling goes after the existing ones (not into a gap above them); collisions are then resolved from there.
          const siblings = map.nodes.filter(n => n.parentId === owner.id && n.id !== node.id);
          const minTop = siblings.length
            ? Math.max(...siblings.map(n => n.y + (this.cardHeightOf(n.id) ?? DEFAULT_CARD_HEIGHT))) + LAYOUT_GAP
            : undefined;
          map.nodes = arrangeNewBranch(
            map.nodes,
            owner.id,
            new Set([node.id]),
            this.cardHeightOf,
            minTop,
            layoutOf(map)
          );
        } else if (!parent) {
          const roots = map.nodes.filter(n => n.id !== node.id && !n.parentId);
          if (roots.length)
            node.y = Math.max(...roots.map(n => n.y + (this.cardHeightOf(n.id) ?? DEFAULT_CARD_HEIGHT))) + LAYOUT_GAP;
        }
      },
      rebuildDerivedData,
      [node.path]
    );
    if (!focus) return;
    if (this.map) this.map.viewport.zoom = Math.max(this.map.viewport.zoom, 0.7);
    const placed = this.map?.nodes.find(n => n.id === node.id) ?? node;
    this.focusNode(placed);
    // focusNode only moves the camera; the dialog handed DOM focus back to the old card, so give it to the new one.
    if (keyboardFocus && this.cardEls.has(placed.id)) this.moveKeyboardFocus(placed);
  }
  private async proposeChildren(
    parent: MapNode,
    options?: TaskOptions,
    direction = "",
    found?: (items: Suggestion[], create: (items: Suggestion[]) => Promise<void>) => void,
    failed?: (message: string, retryable?: boolean) => void,
    acceptedCallback?: () => void
  ): Promise<void> {
    if (this.plugin.expansionCoordinator.isRunning(parent.path)) {
      failed?.(t("ui.ai_running_ai"));
      return;
    }
    const previousBatch = this.plugin.expansionBatches.get(parent.path);
    const pending = this.plugin.pendingSuggestions.get(parent.path);
    const present = (items: Suggestion[]): void => {
      const version = this.plugin.pendingSuggestions.get(parent.path);
      const names = items.filter(item => !item.parentTitle).map(item => item.title);
      if (new Set(names).size !== names.length) {
        this.plugin.pendingSuggestions.delete(parent.path);
        this.plugin.pendingResearchOptions.delete(parent.path);
        const message = t("ui.ai_proposed_duplicate_first_level_names_generate_the_proposa");
        if (failed) failed(message);
        else new Notice(message);
        return;
      }
      if (!found) {
        this.openChildSuggestions(parent, items);
        return;
      }
      found(items, async selected => {
        if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
        let createdNodes: MapNode[] = [];
        const savedOptions = this.plugin.pendingResearchOptions.get(parent.path);
        const researchOptions = savedOptions
          ? { ...savedOptions, signal: options?.signal, onProgress: options?.onProgress }
          : undefined;
        await this.plugin.mutate(async () => {
          if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version)
            throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          await this.assertSuggestionOrigin(parent, version);
          try {
            createdNodes = await this.createChildBatch(
              parent,
              selected,
              researchOptions,
              undefined,
              options?.detailTemplateId ?? researchOptions?.detailTemplateId
            );
          } catch (error) {
            if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(parent.path, error);
            throw error;
          }
          this.plugin.pendingSuggestions.delete(parent.path);
          this.plugin.pendingResearchOptions.delete(parent.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
          this.render();
        });
        if (researchOptions?.shallowResearch && createdNodes.length)
          await this.startShallowResearch(parent, createdNodes, researchOptions);
      });
    };
    if (pending?.length) {
      if (options) {
        if (options.shallowResearch) this.plugin.pendingResearchOptions.set(parent.path, this.researchChoices(options));
        else this.plugin.pendingResearchOptions.delete(parent.path);
      }
      present(options ? pending.filter(item => !item.parentTitle) : pending);
      return;
    }
    if (this.plugin.running.has(parent.path)) {
      failed?.(t("ui.ai_running_ai"));
      return;
    }
    const controller = new AbortController();
    const modalSignal = options?.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    let accepted = false;
    const acceptDispatch = (): void => {
      if (accepted || controller.signal.aborted) return;
      accepted = true;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      acceptedCallback?.();
    };
    const releaseTask = (): void => {
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      if (this.plugin.activeTasks.get(parent.path) === controller) this.plugin.activeTasks.delete(parent.path);
      this.plugin.running.delete(parent.path);
      if (!this.plugin.expansionCoordinator.isRunning(parent.path)) this.plugin.quickExpandPending.delete(parent.path);
    };
    this.plugin.running.add(parent.path);
    this.plugin.quickExpandPending.add(parent.path);
    this.plugin.activeTasks.set(parent.path, controller);
    this.render();
    try {
      const note = await this.plugin.repo.readNote(parent.path, this.map ?? undefined);
      const used = await this.modelFor(note, parent.path, options?.runOnce);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const outputLanguage = options?.outputLanguage ?? this.plugin.settings.language;
      const existing =
        this.map?.nodes
          .filter(item => item.parentId === parent.id)
          .map(item => {
            const child = this.notes.get(item.id);
            return `- ${child?.title || item.path}: ${summaryForPrompt(child?.summary || noSummaryYet(outputLanguage), outputLanguage)}`;
          })
          .join("\n") || inLanguage(NONE, outputLanguage);
      const task = expansionTask(outputLanguage, existing, direction);
      const result = await this.plugin.askModel(
        withThinkingOrigin(
          {
            title: note.title,
            summary: summaryForPrompt(note.summary, outputLanguage),
            rules: "",
            detail: note.detail,
            task: [task, options?.requirements].filter(Boolean).join("\n\n"),
            ancestors: await this.ancestorContext(parent, outputLanguage),
            referenceGroups: options?.referenceGroups,
            outputLanguage: options?.outputLanguage,
            ...this.toneField(note, options),
            mode: "decompose",
            researchMode: options?.researchMode ?? "research",
            researchDepth: options?.researchDepth ?? "normal",
            visualMode: "off"
          },
          note
        ),
        used.model,
        used.reasoning,
        controller.signal,
        undefined,
        acceptDispatch
      );
      if (!accepted) acceptDispatch();
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const suggestions = result.suggestions.filter(item => !item.parentTitle).slice(0, 7);
      if (suggestions.length === 0) {
        const message = result.detail.trim() || t("ui.ai_does_not_recommend_decomposition_or_did_not_propose_3_to");
        if (failed) failed(message);
        else new Notice(message);
        return;
      }
      const latest = await this.plugin.repo.readNote(parent.path, this.map ?? undefined);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (latest.thinkingOrigin !== note.thinkingOrigin)
        throw new Error(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
      const pendingItems = suggestions.map(item => ({
        ...item,
        thinkingOriginBaseline: originBaseline(note.thinkingOrigin)
      }));
      this.plugin.pendingSuggestions.set(parent.path, pendingItems);
      await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
      if (controller.signal.aborted) {
        this.plugin.pendingSuggestions.delete(parent.path);
        await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
        throw new DOMException("Aborted", "AbortError");
      }
      if (options?.shallowResearch) this.plugin.pendingResearchOptions.set(parent.path, this.researchChoices(options));
      else this.plugin.pendingResearchOptions?.delete(parent.path);
      present(pendingItems);
    } catch (error) {
      const partial = error instanceof PartialChildBatchError;
      const currentBatch = this.plugin.expansionBatches.get(parent.path);
      const stoppedBatch = currentBatch !== previousBatch && currentBatch?.status === "stopped";
      const cancelled = !partial && (controller.signal.aborted || stoppedBatch);
      if (!cancelled) {
        console.error("Visual Agent Map AI split", error);
        const message = this.plugin.recordFailure(t("log.ai_split_failed"), error);
        if (failed) failed(message, !partial);
        else new Notice(message);
      }
    } finally {
      releaseTask();
      await this.hydrate();
      this.render();
    }
  }
  private async assertSuggestionOrigin(parent: MapNode, suggestions: Suggestion[]): Promise<void> {
    const origin = (await this.plugin.repo.readNote(parent.path, this.map ?? undefined)).thinkingOrigin ?? "";
    if (
      suggestions.every(
        item =>
          item.thinkingOriginBaseline === originBaseline(origin) ||
          (item.thinkingOriginBaseline === undefined && !origin)
      )
    )
      return;
    this.plugin.pendingSuggestions.delete(parent.path);
    this.plugin.pendingResearchOptions.delete(parent.path);
    await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
    throw new Error(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
  }
  private openChildSuggestions(parent: MapNode, suggestions: Suggestion[]): void {
    const version = this.plugin.pendingSuggestions.get(parent.path);
    const roots = suggestions.filter(item => !item.parentTitle).map(item => item.title);
    if (new Set(roots).size !== roots.length) {
      this.plugin.pendingSuggestions.delete(parent.path);
      this.plugin.pendingResearchOptions.delete(parent.path);
      new Notice(t("ui.ai_proposed_duplicate_first_level_names_generate_the_proposa"));
      return;
    }
    new ChildProposalModal(this.app, suggestions.slice(0, 15), items => {
      void (async () => {
        if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
        let researchOptions: TaskOptions | undefined,
          createdNodes: MapNode[] = [];
        await this.plugin.mutate(async () => {
          if (!version || this.plugin.pendingSuggestions.get(parent.path) !== version)
            throw new Error(t("ui.expansion_suggestions_changed_open_them_again"));
          await this.assertSuggestionOrigin(parent, version);
          researchOptions = this.plugin.pendingResearchOptions.get(parent.path);
          try {
            createdNodes = await this.createChildBatch(parent, items, researchOptions);
          } catch (error) {
            if (error instanceof PartialChildBatchError) await this.clearPartialSuggestions(parent.path, error);
            throw error;
          }
          this.plugin.pendingSuggestions.delete(parent.path);
          this.plugin.pendingResearchOptions.delete(parent.path);
          await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
          this.render();
        });
        if (researchOptions?.shallowResearch && createdNodes.length)
          await this.startShallowResearch(parent, createdNodes, researchOptions);
      })().catch(error => {
        new Notice(error instanceof Error ? error.message : String(error));
      });
    }).open();
  }
  /** `detailTemplateId` is the dialog's template choice: it shapes contributions and is recorded on each new child. */
  private async createChildBatch(
    parent: MapNode,
    items: Suggestion[],
    researchOptions?: TaskOptions,
    signal?: AbortSignal,
    detailTemplateId = researchOptions?.detailTemplateId
  ): Promise<MapNode[]> {
    if (this.plugin.expansionCoordinator.isRunning(parent.path)) throw new Error(t("ui.ai_running_ai"));
    if (!this.map?.nodes.some(node => node.id === parent.id && node.path === parent.path))
      throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
    if (!items.length) throw new Error(t("ui.select_at_least_one_subtopic"));
    const rootTitles = new Set(items.filter(item => !item.parentTitle).map(item => item.title));
    if (rootTitles.size !== items.filter(item => !item.parentTitle).length)
      throw new Error(t("ui.first_level_topic_names_must_be_unique"));
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.title)) throw new Error(t("ui.subtopic_names_must_be_unique"));
      if (item.parentTitle && !seen.has(item.parentTitle))
        throw new Error(t("ui.select_the_parent_topic_before_its_child"));
      seen.add(item.title);
    }
    let created = 0;
    // Every history entry the batch pushes (each child, its settings, the final layout) becomes one undo step.
    const historyMark = this.history.mark();
    const createdByTitle = new Map<string, MapNode>(),
      newNodes: MapNode[] = [];
    const contributionTemplate = this.mapDetailTemplate(this.plugin.settings.language, detailTemplateId);
    try {
      for (const item of items) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const owner = item.parentTitle ? createdByTitle.get(item.parentTitle) : parent;
        if (!owner) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
        await this.addNode(owner, item.title, false, false);
        created++;
        const child = this.map.nodes.at(-1)!;
        newNodes.push(child);
        createdByTitle.set(item.title, child);
        await this.noteChange(child, {
          prompt: item.task,
          detail: researchOptions
            ? ""
            : item.contribution
              ? canonicalDetail(item.contribution, noteLanguageOf(this.plugin.settings.language), contributionTemplate)
              : "",
          ...(researchOptions
            ? {
                researchMode: "local" as const,
                visualMode: researchOptions.visualMode
              }
            : {}),
          ...(detailTemplateId ? { detailTemplateId } : {})
        });
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (newNodes.length)
        await this.mapChange(map => {
          map.nodes = arrangeNewBranch(
            map.nodes,
            parent.id,
            new Set(newNodes.map(node => node.id)),
            this.cardHeightOf,
            undefined,
            layoutOf(map)
          );
        }, false);
      if (newNodes.length) this.frameBranch([parent.id, ...newNodes.map(node => node.id)]);
      if (created) await this.plugin.rebuildDerivedData();
      this.history.collapseSince(historyMark);
      this.updateHistoryButtons();
      return newNodes;
    } catch (error) {
      if (created) {
        this.history.collapseSince(historyMark);
        this.updateHistoryButtons();
        await this.plugin.rebuildDerivedData();
        throw new PartialChildBatchError(
          t("ui.some_subtopics_were_created_reopen_this_window_and_check_the") +
            ` ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  }
  /** Camera on the parent and its new children (current zoom kept, or smaller if they do not fit), saved like a pan. */
  private frameBranch(ids: string[]): void {
    if (!this.map || !this.viewportEl) return;
    const shown = this.map.nodes.filter(node => ids.includes(node.id));
    if (!shown.length) return;
    const bounds = {
      minX: Math.min(...shown.map(n => n.x)),
      maxX: Math.max(...shown.map(n => n.x + 280)),
      minY: Math.min(...shown.map(n => n.y)),
      maxY: Math.max(...shown.map(n => n.y + (this.cardHeightOf(n.id) ?? 180)))
    };
    this.map.viewport = fitViewport(
      bounds,
      { width: this.viewportEl.clientWidth, height: this.viewportEl.clientHeight },
      this.canvasInset(),
      Math.max(0.25, Math.min(1.2, this.map.viewport.zoom))
    );
    this.saveViewport();
  }
  /**
   * Quick research grows the cards after they were placed with estimated heights. Once the batch ends, the cards the
   * user has not moved are laid out again against the measured heights (one Map.md write, no undo step, no AI call).
   */
  private async respaceBatch(parent: MapNode, placed: Map<string, { x: number; y: number }>): Promise<void> {
    if (this.closed || this.builtIn) return;
    // Everything runs inside one queued mutation: a drag queued before it has already landed in this.map, so the
    // "untouched" check, the layout and the write all see the same positions and a dragged card is never overwritten.
    await this.plugin.mutate(
      async () => {
        if (this.closed || !this.map) return;
        const untouched = new Set(
          this.map.nodes.filter(n => placed.get(n.id)?.x === n.x && placed.get(n.id)?.y === n.y).map(n => n.id)
        );
        if (!untouched.size) return;
        const current = this.map.nodes;
        const arranged = arrangeNewBranch(
          current,
          parent.id,
          untouched,
          this.cardHeightOf,
          undefined,
          layoutOf(this.map)
        );
        const target = new Map<string, { x: number; y: number }>();
        arranged.forEach((n, index) => {
          if (untouched.has(n.id) && (n.x !== current[index].x || n.y !== current[index].y))
            target.set(n.id, { x: n.x, y: n.y });
        });
        if (!target.size) return;
        await this.plugin.repo.updateMap(this.path, map => {
          for (const node of map.nodes) {
            const point = target.get(node.id);
            if (point) Object.assign(node, point);
          }
        });
        for (const node of this.map.nodes) {
          const point = target.get(node.id);
          if (point) Object.assign(node, point);
        }
      },
      { sync: false }
    );
  }
  private startShallowResearch(parent: MapNode, children: MapNode[], options: TaskOptions): Promise<void> {
    const signal = options.signal;
    const pendingOptions = this.researchChoices(options);
    const placed = new Map<string, { x: number; y: number }>();
    for (const child of children) {
      const node = this.map?.nodes.find(item => item.id === child.id);
      if (node) placed.set(node.id, { x: node.x, y: node.y });
    }
    let respaced = false;
    this.plugin.quickExpandPending.add(parent.path);
    return this.plugin.expansionCoordinator.start(
      parent.path,
      children,
      // Quick research that reads local context only (the S7 default) is a first look: no diagram call per child.
      (child, batchSignal, accepted) =>
        this.researchChild(child, batchSignal, accepted, pendingOptions, pendingOptions.researchMode !== "local"),
      () => {
        const state = this.plugin.expansionBatches.get(parent.path);
        if (state?.status === "running") this.plugin.quickExpandPending.add(parent.path);
        else this.plugin.quickExpandPending.delete(parent.path);
        if (state && state.status !== "running" && !respaced) {
          respaced = true;
          void this.respaceBatch(parent, placed)
            .catch(() => undefined)
            .then(() => {
              if (!this.closed) this.render();
            });
          return;
        }
        this.render();
      },
      signal
    );
  }
  private async researchChild(
    child: MapNode,
    batchSignal: AbortSignal,
    accepted: () => void,
    choices: TaskOptions,
    charts = true,
    onResult?: (result: AiResult) => void
  ): Promise<void> {
    const detailTemplate = await this.detailTemplateFor(child, choices.detailTemplateId, choices.toneId);
    const note = await this.plugin.repo.readNote(child.path, this.map ?? undefined);
    const outputLanguage =
      choices.outputLanguage ?? outputLanguageForMap(this.map, this.plugin.settings.language, note.title);
    let started = false;
    let failure: string | undefined;
    const handle = await this.runAgent(
      child,
      onResult,
      message => {
        failure = message;
      },
      {
        detailTemplate,
        rules: "",
        referenceGroups: choices.referenceGroups ?? [],
        signal: batchSignal,
        outputLanguage,
        researchMode: choices.researchMode,
        researchDepth: choices.researchDepth,
        visualMode: choices.visualMode,
        mapAiMode: choices.mapAiMode,
        addCharts: charts,
        task: [note.prompt || researchTopicTask(outputLanguage, note.title), choices.requirements]
          .filter(Boolean)
          .join("\n\n")
      },
      () => {
        started = true;
        accepted();
      },
      choices.runOnce
    );
    if (!started || !handle) throw new Error(failure ?? t("ui.shallow_research_did_not_start"));
    await handle.finished;
    if (failure && !batchSignal.aborted) throw new Error(failure);
  }
  private multiResearchKey(): string {
    return `multi-research:${this.path}`;
  }
  private openMultiResearch(retryBatchKey?: string): void {
    if (!this.map || this.map.aim || !this.multiSelected.size) return;
    const shown = [...this.multiSelected].flatMap(id => {
      const note = this.notes.get(id);
      return note ? [{ name: note.title, mode: noteAiMode(note.researchMode) }] : [];
    });
    const names = shown.map(item => item.name);
    new MultiResearchModal(
      this.app,
      names,
      this.modelChoices(),
      this.templateChoices(),
      request => void this.startMultiResearch(request, retryBatchKey),
      this.toneChoices(),
      (selected, refreshed) =>
        new PromptPresetsModal(this.app, this.plugin, "tone", () => refreshed(this.toneChoices()), selected).open(),
      this.fieldLinks(),
      shown.map(item => item.mode)
    ).open();
  }
  stopMultiResearch(): void {
    this.plugin.expansionCoordinator.stop(this.multiResearchKey());
  }
  /**
   * `onSettled` (the chat's research) hears once how the batch's web activity came out, when the batch has ended: searches made,
   * topics that were counted, and how many of those made none.
   */
  async startMultiResearch(
    request: MultiResearchRequest,
    retryBatchKey?: string,
    onSettled?: (web: ResearchWebTally) => void
  ): Promise<void> {
    if (!this.map || this.map.aim || this.builtIn || !this.multiSelected.size) return;
    const key = this.multiResearchKey();
    if (this.plugin.expansionCoordinator.isRunning(key)) {
      new Notice(t("ui.multi_research_already_running"));
      return;
    }
    const selected = [...this.multiSelected]
      .map(id => this.map!.nodes.find(node => node.id === id))
      .filter((node): node is MapNode => !!node);
    try {
      // The usage notice of every model the batch will really use, once each, in order; a refusal starts nothing.
      const models = request.model
        ? [request.model]
        : [
            ...new Set(
              (
                await Promise.all(
                  selected.map(node => this.plugin.repo.resolveTopicModel(node.path, this.map ?? undefined))
                )
              ).map(item => (item.origin === "override" ? item.model : this.currentModelId()))
            )
          ];
      if (!models.length) models.push(this.plugin.settings.cliModel);
      const confirmEach = async (index: number, run: () => Promise<void>): Promise<boolean> =>
        index >= models.length
          ? (await run(), true)
          : this.plugin.confirmAiUsage(models[index], async () => {
              await confirmEach(index + 1, run);
            });
      await confirmEach(0, async () => {
        if (this.plugin.expansionCoordinator.isRunning(key)) {
          new Notice(t("ui.multi_research_already_running"));
          return;
        }
        const busy = (node: MapNode): boolean =>
          this.plugin.running.has(node.path) ||
          this.plugin.quickExpandPending.has(node.path) ||
          this.plugin.activeTasks.has(node.path);
        const nodes = selected.filter(node => !busy(node));
        if (!nodes.length) {
          new Notice(t("ui.multi_research_all_skipped"));
          return;
        }
        if (nodes.length < selected.length) new Notice(t("ui.multi_research_skipped", selected.length - nodes.length));
        // The batch runs in the background: leave selection mode so the selection bar gets out of the way.
        this.integrationMode = false;
        this.multiSelected.clear();
        if (!this.closed) this.render();
        const shared = {
          referenceGroups: [],
          requirements: request.requirements,
          // The picked model is for this batch only (D4): it never becomes a topic's own model.
          ...(request.model ? { runOnce: { model: request.model } } : {}),
          ...(request.detailTemplateId ? { detailTemplateId: request.detailTemplateId } : {}),
          ...(request.toneId ? { toneId: request.toneId } : {})
        };
        // The map chat may set the research choices for the whole batch (as before); the dialog never does, so each topic then
        // runs in the mode its own note stores: Quick without the web and without charts, Standard with both.
        const choicesFor = (note: Note): TaskOptions =>
          request.researchMode !== undefined
            ? {
                // The mode follows the override (local = Quick), so a Quick run gets the Quick prompt and no charts.
                ...aiModeOptions(noteAiMode(request.researchMode), "research"),
                researchMode: request.researchMode,
                researchDepth: request.researchDepth ?? "normal",
                visualMode: request.imageSearch ? "auto" : "off",
                ...shared
              }
            : { ...aiModeOptions(noteAiMode(note.researchMode), "research"), ...shared };
        // A retry replaces the failure state of the batch it came from (a running batch is never touched).
        if (retryBatchKey && this.plugin.expansionBatches.get(retryBatchKey)?.status !== "running")
          this.plugin.expansionBatches.delete(retryBatchKey);
        let reported = false;
        let skipped = 0;
        // Web activity of the topics that finished: Research mode only (a local run searches nothing, so it has nothing to report).
        const web: ResearchWebTally = { searches: 0, counted: 0, withoutSearch: 0 };
        try {
          await this.plugin.expansionCoordinator.start(
            key,
            nodes,
            async (child, batchSignal, accepted) => {
              if (busy(child)) {
                skipped++;
                accepted();
                return "skipped";
              }
              const choices = choicesFor(await this.plugin.repo.readNote(child.path, this.map ?? undefined));
              await this.researchChild(child, batchSignal, accepted, choices, choices.mapAiMode !== "quick", result => {
                if (choices.researchMode !== "research" || result.retrievals === undefined) return;
                web.counted++;
                web.searches += result.retrievals;
                if (!result.retrievals) web.withoutSearch++;
              });
              return undefined;
            },
            () => {
              const state = this.plugin.expansionBatches.get(key);
              if (state && state.status !== "running" && !reported) {
                reported = true;
                new Notice(
                  [
                    t(
                      state.status === "stopped" ? "ui.multi_research_stopped" : "ui.multi_research_finished",
                      state.succeeded,
                      state.total,
                      state.failures.length,
                      skipped
                    ),
                    ...researchWebLines(web).map(line => line.text)
                  ].join(" ")
                );
                onSettled?.(web);
              }
              if (!this.closed) this.render();
            }
          );
        } catch {
          // Launch rejection from the coordinator (stopped or all failed) is reported by the summary Notice.
        }
      });
    } catch (error) {
      new Notice(errorMessage(error));
    }
  }
  /** Counts that cannot be misread: succeeded of total, failures, optional current topic and stopped marker. */
  private batchProgressLabel(counts: string, batch: ExpansionBatchState, current?: string): string {
    return [
      counts,
      batch.failures.length ? t("ui.batch_failed_count", batch.failures.length) : "",
      batch.status === "running" ? (current ?? "") : "",
      batch.status === "stopped" ? t("ui.shallow_research_stopped") : ""
    ]
      .filter(Boolean)
      .join(" · ");
  }
  /** Failed topics of a finished batch that still exist on the current map. */
  private retryableFailures(batch: ExpansionBatchState): MapNode[] {
    if (batch.status === "running" || !this.map || this.map.aim || this.builtIn) return [];
    return batch.failedPaths
      .map(path => this.map!.nodes.find(node => node.path === path))
      .filter((node): node is MapNode => !!node);
  }
  private renderRetryFailedButton(parent: HTMLElement, batchKey: string, batch: ExpansionBatchState): void {
    const failed = this.retryableFailures(batch);
    if (failed.length) {
      this.button(parent, t("ui.retry_failed_topics", failed.length), () => this.retryFailed(batchKey));
      this.renderOtherProviderButton(parent, failed, batchKey);
    }
  }
  /**
   * The model on the other provider that every one of `nodes` can be retried with, or null. Each topic must be in error with a
   * provider error (quota, auth, unavailable model) and all must point at the same target; mixed batches get none (D13).
   */
  private otherProviderTarget(nodes: MapNode[]): string | null {
    if (!nodes.length) return null;
    // Test doubles of older suites have no model list; a missing one means there is no other provider to offer.
    const available = typeof this.plugin.availableModels === "function" ? this.plugin.availableModels() : [];
    const targets = new Set<string | null>();
    for (const node of nodes) {
      const note = this.notes.get(node.id);
      if (!note || note.status !== "error" || !classifyProviderError(note.lastError)) return null;
      const failed = providerOfFailure(note.lastError, note.model);
      targets.add(otherProviderModel(failed, available, this.currentModelId()));
    }
    const [target] = [...targets];
    return targets.size === 1 && target ? target : null;
  }
  /** "Retry with <other provider>": only when {@link otherProviderTarget} has one. Never an automatic switch. */
  private renderOtherProviderButton(parent: HTMLElement, nodes: MapNode[], retryBatchKey?: string): void {
    if (this.builtIn || this.map?.aim) return;
    const target = this.otherProviderTarget(nodes);
    if (!target) return;
    this.button(
      parent,
      t("ui.retry_with_other_provider_0", this.plugin.modelLabel(target)),
      () => void this.retryWithOtherProvider(nodes, target, retryBatchKey)
    );
  }
  /** Retries `nodes` with `model` for this run only (through the batch's run-once model): no setting or frontmatter is written. */
  private async retryWithOtherProvider(nodes: MapNode[], model: string, retryBatchKey?: string): Promise<void> {
    this.multiSelected = new Set(nodes.map(node => node.id));
    await this.startMultiResearch({ requirements: "", model }, retryBatchKey);
  }
  /** Selects the failed topics and opens the multi-research dialog so the owner can pick another model. */
  private retryFailed(batchKey: string): void {
    const batch = this.plugin.expansionBatches.get(batchKey);
    if (!batch) return;
    const failed = this.retryableFailures(batch);
    if (!failed.length) return;
    this.multiSelected = new Set(failed.map(node => node.id));
    this.integrationMode = true;
    if (!this.closed) this.render();
    this.openMultiResearch(batchKey);
  }
  /** Status bar under the toolbar (same place and look as the AIM status bar) with progress, Stop, and Retry/Dismiss after failures. */
  private renderMultiResearchStatus(parent: HTMLElement): void {
    const key = this.multiResearchKey();
    const state = this.plugin.expansionBatches.get(key);
    if (!state) return;
    const running = state.status === "running";
    if (!running && !state.failures.length) return;
    const bar = parent.createDiv(`vam-aim-statusbar vam-multi-research-statusbar${running ? " is-active" : ""}`);
    bar.setAttr("aria-live", "polite");
    const current = state.currentPath ? this.map?.nodes.find(node => node.path === state.currentPath) : undefined;
    const title = current ? this.notes.get(current.id)?.title : undefined;
    bar.createSpan({ cls: "vam-aim-status-title", text: t("ui.multi_research") });
    bar.createSpan({
      cls: `vam-aim-status-value ${running ? "vam-status-running" : "vam-status-error"}`,
      text: this.batchProgressLabel(
        t(running ? "ui.multi_research_progress" : "ui.multi_research_ended", state.succeeded, state.total),
        state,
        title
      )
    });
    if (running) this.button(bar, t("ui.stop_research"), () => this.stopMultiResearch());
    else {
      this.renderRetryFailedButton(bar, key, state);
      const dismiss = this.button(bar, "×", () => {
        this.plugin.expansionBatches.delete(key);
        if (!this.closed) this.render();
      });
      dismiss.setAttr("aria-label", t("ui.dismiss"));
    }
  }
  /** The sample start's "no models found" button: it checks the CLI of the chosen model (Claude Code or Codex). */
  /** No model is usable yet: neither Codex models nor a ready Claude Code. Claude counts, so a Claude-only setup gets no check button. */
  private needsConnectionCheck(): boolean {
    return !this.plugin.availableModels().length;
  }
  private renderConnectionCheck(actions: HTMLElement): HTMLButtonElement {
    const claude = providerForModel(this.plugin.settings.cliModel) === "claude";
    return this.button(actions, t(claude ? "ui.check_claude_code" : "ui.check_codex"), () =>
      claude ? this.plugin.repairConnection() : this.enqueue(() => this.plugin.recheckCodex())
    );
  }
  private renderSelectionBar(workspace: HTMLElement): HTMLElement {
    const selection = workspace.createDiv("vam-selection-bar");
    const names = [...this.multiSelected].map(id => this.notes.get(id)?.title).filter(Boolean);
    selection.createSpan({
      attr: { dir: "auto" },
      text: this.multiSelected.size
        ? t(
            "ui.selected_0_1_2",
            this.multiSelected.size,
            names.slice(0, 2).join(t("ui.list_separator")),
            names.length > 2 ? "…" : ""
          )
        : t("ui.prompt_select_topics")
    });
    // One fixed line under the names: it cannot cover the canvas and never moves the buttons.
    selection.createSpan({ cls: "vam-hint vam-selection-hint", text: t("ui.drag_to_select_topics_hint") });
    this.button(
      selection,
      t("ui.clear"),
      () => {
        const touched = [...this.multiSelected];
        this.multiSelected.clear();
        this.commitSelection(this.selected, this.selected, touched);
      },
      !this.multiSelected.size
    );
    this.button(selection, t("ui.remove"), () => this.confirmRemoveSelected(), !this.multiSelected.size);
    // Frames are added from here (the only multi-selection surface); AIM maps and the built-in sample get no entry (D11).
    if (!this.map?.aim && !this.builtIn)
      this.button(selection, t("ui.canvas_boundary_add"), () => this.openAddBoundary(), !this.multiSelected.size);
    this.button(selection, t("ui.move_to"), () => this.chooseSelectedParent(false), !this.multiSelected.size);
    this.button(selection, t("ui.copy_to"), () => this.chooseSelectedParent(true), !this.multiSelected.size);
    const count = this.multiSelected.size;
    // Labels never carry the count (it would shift every button to the right of it on each selection change);
    // screen readers still hear it through aria-label.
    const synthesize = this.button(selection, t("ui.synthesize"), () => this.integrateSelected(), count < 2);
    synthesize.addClass("mod-cta");
    if (count > 1) synthesize.setAttr("aria-label", t("ui.synthesize_0_topics", count));
    if (!this.map?.aim && !this.builtIn) {
      // Not natively disabled: a disabled button cannot take focus, so keyboard and screen-reader users could not read why.
      const check = this.mergeCheck(),
        merge = this.button(selection, t("ui.merge"), () => this.openMerge());
      if (count > 1) merge.setAttr("aria-label", t("ui.merge_0_topics", count));
      if (!check.ok) {
        merge.setAttr("aria-disabled", "true");
        merge.setAttr("title", t(check.reason));
      }
    }
    if (!this.map?.aim) {
      const running = this.plugin.expansionBatches.get(this.multiResearchKey())?.status === "running";
      const research = this.button(
        selection,
        t("ui.multi_research"),
        () => this.openMultiResearch(),
        !this.multiSelected.size || running
      );
      if (count)
        research.setAttr("aria-label", count > 1 ? t("ui.research_0_topics", count) : t("ui.research_one_topic"));
    }
    return selection;
  }
  /** The dialog's choices for each child's research; the data sources the user picked go to every child. */
  private researchChoices(options: TaskOptions): TaskOptions {
    const { signal: _signal, onProgress: _onProgress, ...choices } = options;
    return { ...choices, signal: undefined, onProgress: undefined, referenceGroups: options.referenceGroups ?? [] };
  }
  private async clearPendingSuggestions(path: string): Promise<void> {
    this.plugin.pendingSuggestions.delete(path);
    this.plugin.pendingResearchOptions.delete(path);
    try {
      await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
    } catch (error) {
      throw new Error(this.plugin.recordFailure(t("ui.expansion_suggestions_changed_open_them_again"), error));
    }
  }
  private async clearPartialSuggestions(path: string, partial: PartialChildBatchError): Promise<void> {
    try {
      await this.clearPendingSuggestions(path);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new PartialChildBatchError(`${partial.message} ${detail}`);
    }
  }
  private async ancestorContext(node: MapNode, language: ContentLanguage): Promise<string> {
    const chain: MapNode[] = [],
      seen = new Set([node.id]);
    let parent = node.parentId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const n = this.map?.nodes.find(item => item.id === parent);
      if (!n) break;
      chain.unshift(n);
      parent = n.parentId;
    }
    const ancestors: string[] = [];
    for (const n of chain) {
      const info = await this.plugin.repo.readNote(n.path, this.map ?? undefined);
      ancestors.push(
        `- ${info.title}\n  ${labelCurrentSummary(language)}: ${summaryForPrompt(info.summary, language)}`
      );
    }
    return ancestors.join("\n");
  }
  private referenceSourcePaths(note: Note, ownerPath: string): string[] {
    if (note.sourcePaths.length) return [...new Set(note.sourcePaths)];
    const markers = [
      "### 整合來源（保存內容）",
      "### 萃取來源（強連結備份）",
      "### 萃取來源（弱連結）",
      "### 合併來源"
    ];
    const marker = markers.find(value => note.detail.includes(value));
    if (!marker) return [];
    const section = note.detail.slice(note.detail.indexOf(marker) + marker.length);
    const paths = [...section.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)].map(match => {
      const link = match[1],
        direct = link.endsWith(".md") ? link : `${link}.md`;
      if (this.app.vault.getAbstractFileByPath(direct) instanceof TFile) return direct;
      return this.app.metadataCache.getFirstLinkpathDest(link, ownerPath)?.path ?? direct;
    });
    return [...new Set(paths)];
  }
  private async proposeIntegrationDirections(
    node: MapNode,
    options: TaskOptions,
    found: (items: Suggestion[]) => void,
    failed: (message: string) => void,
    accepted?: () => void
  ): Promise<void> {
    if (!this.map) {
      failed(t("ui.no_mind_map_is_available"));
      return;
    }
    if (this.plugin.running.has(node.path)) {
      failed(t("ui.ai_running_ai"));
      return;
    }
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length && !options.referenceGroups?.some(group => group.documents.length)) {
      failed(t("ui.choose_another_note_source_first"));
      return;
    }
    const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    const used = await this.modelFor(note, node.path, options.runOnce);
    this.plugin.running.add(node.path);
    this.render();
    const progress = this.startTaskProgress(node.path, used.model);
    try {
      const childSources = await this.topicReferenceGroup(
        children,
        options?.synthesisContent === "summary" ? "summary" : "strong"
      );
      const selectedSources = options.referenceGroups ?? [];
      if (!children.length && !selectedSources.some(group => group.documents.length)) {
        failed(t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi"));
        return;
      }
      // Task text, placeholders and ancestor labels follow the output note language, as in the other task paths.
      const promptLanguage = options.outputLanguage ?? this.plugin.settings.language;
      const task = synthesisDirectionsTask(promptLanguage);
      const result = await this.plugin.askModel(
        withThinkingOrigin(
          {
            title: note.title,
            summary: summaryForPrompt(note.summary, promptLanguage),
            rules: "",
            detail: note.detail,
            task: [task, options?.requirements].filter(Boolean).join("\n\n"),
            ancestors: await this.ancestorContext(node, promptLanguage),
            workingFindings: note.newFindings,
            referenceGroups: [...selectedSources, childSources],
            // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
            referenceDelivery: "direct",
            onProgress: options.onProgress,
            outputLanguage: options.outputLanguage,
            ...this.toneField(note, options),
            mode: "synthesize",
            researchMode: options.researchMode,
            researchDepth: options.researchDepth,
            visualMode: "off"
          },
          note
        ),
        used.model,
        used.reasoning,
        options.signal,
        undefined,
        accepted,
        undefined,
        progress.observer
      );
      progress.end();
      accepted?.();
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const angles = result.suggestions.slice(0, 2);
      if (!angles.length) {
        failed(t("ui.ai_did_not_suggest_a_synthesis_direction_please_retry"));
        return;
      }
      found(angles);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        failed(t("ui.research_stopped_existing_content_was_preserved"));
        return;
      }
      console.error("Visual Agent Map integration directions", error);
      failed(this.plugin.recordFailure(t("log.integration_directions_failed"), error));
    } finally {
      progress.end();
      this.plugin.running.delete(node.path);
      await this.hydrate();
      this.render();
    }
  }
  private async integrateChildren(
    node: MapNode,
    options?: TaskOptions,
    direction = "",
    drafted?: SynthesisWrite,
    failed?: (message: string) => void,
    accepted?: () => void
  ): Promise<void> {
    if (!this.map || this.plugin.running.has(node.path)) {
      failed?.(t("ui.ai_running_ai"));
      return;
    }
    const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    const used = await this.modelFor(note, node.path, options?.runOnce);
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length && !options?.referenceGroups?.some(group => group.documents.length)) {
      const message = t("ui.choose_another_note_source_first");
      if (failed) failed(message);
      else new Notice(message);
      return;
    }
    const childSources = await this.topicReferenceGroup(
      children,
      options?.synthesisContent === "summary" ? "summary" : "strong",
      { language: options?.outputLanguage }
    );
    const sourceSnapshot = JSON.stringify(childSources.documents);
    const childIds = children
      .map(child => child.id)
      .sort()
      .join("|");
    const mapPath = this.path,
      mapId = this.map.id;
    const noteSnapshot = JSON.stringify([
      note.title,
      note.summary,
      note.detail,
      note.prompt,
      note.rules,
      note.model,
      note.reasoning,
      note.sourcePaths,
      note.referencePaths,
      note.thinkingOrigin,
      note.newFindings
    ]);
    const selectedSources = options?.referenceGroups ?? [];
    if (!children.length && !selectedSources.some(group => group.documents.length)) {
      const message = t("ui.the_selected_sources_contain_no_markdown_content_to_synthesi");
      if (failed) failed(message);
      else new Notice(message);
      return;
    }
    const language = this.plugin.settings.language;
    const task = direction || synthesisGoalTask(language);
    const detailTemplate = templateInLanguage(
      await this.detailTemplateFor(node, options?.detailTemplateId, options?.toneId),
      options?.outputLanguage ?? language
    );
    this.plugin.abortChartJobs(node.path);
    this.plugin.running.add(node.path);
    await this.plugin.repo.updateNote(node.path, { status: "running" });
    await this.hydrate();
    this.render();
    const progress = this.startTaskProgress(node.path, used.model);
    // True only when the whole of the parent's Working Findings was in the prompt; otherwise they stay for the next run.
    let findingsSent = false;
    try {
      const synthesisContext: TaskContext = withThinkingOrigin(
        {
          title: note.title,
          summary: summaryForPrompt(note.summary, options?.outputLanguage ?? language),
          rules: "",
          detail: note.detail,
          task: [task, options?.requirements].filter(Boolean).join("\n\n"),
          ancestors: await this.ancestorContext(node, options?.outputLanguage ?? language),
          workingFindings: note.newFindings,
          onWorkingFindingsSent: sent => {
            findingsSent = sent === note.newFindings;
          },
          referenceGroups: [...selectedSources, childSources],
          // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
          referenceDelivery: "direct",
          onProgress: options?.onProgress,
          outputLanguage: options?.outputLanguage,
          ...this.toneField(note, options),
          mode: "synthesize",
          researchMode: options?.researchMode ?? "local",
          researchDepth: options?.researchDepth ?? "normal",
          visualMode: options?.visualMode ?? note.visualMode,
          detailTemplate,
          addCharts: true
        },
        note
      );
      const result = await this.plugin.askModel(
        synthesisContext,
        used.model,
        used.reasoning,
        options?.signal,
        undefined,
        accepted,
        undefined,
        progress.observer
      );
      // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
      progress.end();
      accepted?.();
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      await this.plugin.repo.updateNote(node.path, { status: note.status });
      const save = async (summary: string, detail: string): Promise<void> =>
        this.plugin.mutate(async () => {
          if (
            options?.signal?.aborted ||
            this.closed ||
            this.path !== mapPath ||
            this.map?.id !== mapId ||
            this.map.nodes
              .filter(item => item.parentId === node.id)
              .map(item => item.id)
              .sort()
              .join("|") !== childIds
          )
            throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
          const currentSources = await this.topicReferenceGroup(
            children,
            options?.synthesisContent === "summary" ? "summary" : "strong",
            { language: options?.outputLanguage }
          );
          if (JSON.stringify(currentSources.documents) !== sourceSnapshot)
            throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          if (
            JSON.stringify([
              latest.title,
              latest.summary,
              latest.detail,
              latest.prompt,
              latest.rules,
              latest.model,
              latest.reasoning,
              latest.sourcePaths,
              latest.referencePaths,
              latest.thinkingOrigin,
              latest.newFindings
            ]) !== noteSnapshot
          )
            throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
          const canonicalOnly = canonicalDetail(
            detail,
            noteLanguageOf(options?.outputLanguage ?? this.plugin.settings.language),
            detailTemplate
          );
          // An edited draft is checked again so the topic's format mark matches what is saved.
          const issues =
            result.formatIssues && detail !== result.detail
              ? checkCounts(canonicalOnly, detailTemplate)
              : result.formatIssues;
          // Links the parent's earlier research had and the rewrite dropped are kept (no AI call; part of the saved detail).
          const references = visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language));
          const canonical = carryForwardSources(
            canonicalOnly,
            [latest.summary, latest.detail, latest.newFindings, latest.visualReferences],
            [summary, canonicalOnly, references],
            options?.outputLanguage ?? this.plugin.settings.language,
            detailTemplate
          );
          await this.plugin.repo.updateNote(
            node.path,
            {
              summary,
              detail: canonical,
              visualReferences: references,
              // The findings are cleared only when the model saw them (the rewrite folds them in); unsent ones stay.
              ...(findingsSent ? { newFindings: "" } : {}),
              status: "completed",
              ...formatIssuesPatch(issues, language)
            },
            { detailTemplate }
          );
          const saved = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          this.recordNoteWrite(
            node.path,
            { ...latest, status: note.status },
            saved,
            [
              "summary",
              "detail",
              "visualReferences",
              "newFindings",
              "previewSection",
              "previewInitialized",
              "previewAutoHash",
              "status",
              "lastError",
              "detailFormatIssues"
            ],
            t("ui.synthesize_subtopics")
          );
          await this.hydrate();
          this.render();
          this.queueCharts({
            path: node.path,
            saved,
            context: synthesisContext,
            detail: saved.detail,
            formatIssues: issues,
            model: used.model,
            language: options?.outputLanguage ?? this.plugin.settings.language,
            template: detailTemplate
          });
        });
      // The result is written directly (no draft review); a write that fails or finds the topic changed writes
      // nothing and is reported, without marking the parent topic as failed.
      try {
        await (
          drafted ??
          (async (_result, write, summary, detail) => {
            const previous = this.history.undoEntry;
            await write(summary, detail);
            this.undoNotice(t("ui.synthesis_written_0", note.title), previous);
          })
        )(result, save, result.summary, result.detail);
      } catch (error) {
        if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          if (failed) failed(t("ui.research_stopped_existing_content_was_preserved"));
          else new Notice(t("ui.research_stopped_existing_content_was_preserved"));
        } else {
          console.error("VAM synthesis write", error);
          const message = this.plugin.recordFailure(t("log.child_integration_failed"), error);
          if (failed) failed(message);
          else new Notice(message);
        }
      }
    } catch (error) {
      if (options?.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        await this.plugin.repo.updateNote(node.path, { status: note.status });
        if (failed) failed(t("ui.research_stopped_existing_content_was_preserved"));
        else new Notice(t("ui.research_stopped_existing_content_was_preserved"));
      } else {
        console.error("Visual Agent Map child integration", error);
        await this.plugin.repo.updateNote(node.path, { status: "error", lastError: failureReason(error) });
        const message = this.plugin.recordFailure(t("log.child_integration_failed"), error);
        if (failed) failed(message);
        else new Notice(message);
      }
    } finally {
      progress.end();
      this.plugin.running.delete(node.path);
      await this.hydrate();
      this.render();
    }
  }
  private async startSynthesis(
    node: MapNode,
    options: TaskOptions,
    direction: string | null,
    failed: (message: string) => void,
    accepted: () => void,
    observer?: SynthesisObserver
  ): Promise<void> {
    const path = node.path;
    const existing = this.synthesisTasks.get(path);
    const step = direction === null ? "directions" : "draft";
    if (!this.map) {
      failed(t("ui.no_mind_map_is_available"));
      return;
    }
    if (this.plugin.running.has(path) || this.plugin.activeTasks.has(path) || existing?.state === "running") {
      failed(t("ui.ai_running_ai"));
      return;
    }
    if (step === "directions" && existing?.state === "directions") {
      failed(t("ui.synthesis_pending_review_first"));
      return;
    }
    if (step === "draft") {
      // A draft follows chosen directions, or starts fresh when the suggestions were skipped; it never overwrites
      // a draft that is still waiting for review.
      if (existing && (existing.mapPath !== this.path || existing.mapId !== this.map.id)) {
        failed(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        return;
      }
    }
    const controller = new AbortController();
    const modalSignal = options.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    const stored = { ...options, signal: undefined, onProgress: undefined };
    const task: NonNullable<ReturnType<VisualAgentMapView["synthesisTasks"]["get"]>> =
      step === "draft" &&
      existing?.directions.length &&
      (existing.state === "directions" || options.continuesDirections)
        ? existing
        : {
            mapPath: this.path,
            mapId: this.map.id,
            state: "running",
            step,
            controller,
            progress: "",
            options: stored,
            directions: [],
            direction: ""
          };
    task.state = "running";
    task.step = step;
    task.controller = controller;
    task.progress = "";
    task.direction = direction ?? "";
    this.synthesisTasks.set(path, task);
    this.plugin.activeTasks.set(path, controller);
    const runOptions: TaskOptions = {
      ...(step === "draft"
        ? { ...task.options, requirements: options.requirements || task.options.requirements }
        : options),
      // The model of this step is the dialog's choice now, not the one the first step was started with.
      runOnce: options.runOnce,
      signal: controller.signal,
      onProgress: message => {
        task.progress = message;
        options.onProgress?.(message);
        if (this.synthesisTasks.get(path) === task) this.render();
      }
    };
    let launched = false;
    let outcome: "found" | "written" | "failed" | null = null;
    const markAccepted = (): void => {
      if (launched || controller.signal.aborted) return;
      launched = true;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      observer?.accepted?.(() => controller.abort());
      accepted();
    };
    const fail = (message: string): void => {
      if (outcome) return;
      outcome = "failed";
      if (this.synthesisTasks.get(path) === task) {
        if (controller.signal.aborted && observer?.isOpen()) {
          // Stopped from the open dialog: nothing was produced, so leave no badge behind. A draft that was stopped
          // returns to its directions; a directions request that was stopped just goes away.
          if (step === "draft" && task.directions.length) task.state = "directions";
          else this.synthesisTasks.delete(path);
        } else if (!launched && step === "draft" && task.directions.length) task.state = "directions";
        else {
          task.state = controller.signal.aborted ? "cancelled" : "failed";
          task.progress = message;
        }
      }
      failed(message);
    };
    try {
      if (step === "directions")
        await this.proposeIntegrationDirections(
          node,
          runOptions,
          items => {
            // A result that arrives after Stop or after the task was replaced is dropped.
            if (controller.signal.aborted || this.synthesisTasks.get(path) !== task) return;
            outcome = "found";
            task.state = "directions";
            task.directions = items;
            // Shown in the dialog when it is still open; otherwise the node badge and one Notice carry it.
            if (observer?.isOpen() && observer.directions) observer.directions(items);
            else
              backgroundResultNotice(t("ui.background_synthesis_directions_ready"), {
                label: t("ui.choose_synthesis_direction"),
                open: () => this.openSynthesisDirections(node, task)
              });
          },
          fail,
          markAccepted
        );
      else
        await this.integrateChildren(
          node,
          runOptions,
          direction ?? "",
          async (_result, save, summary, detail) => {
            // Stop, close or a replaced task before the write: nothing is written.
            if (controller.signal.aborted || this.synthesisTasks.get(path) !== task) return;
            const previous = this.history.undoEntry;
            await save(summary, detail);
            outcome = "written";
            if (this.synthesisTasks.get(path) === task) this.synthesisTasks.delete(path);
            this.undoNotice(t("ui.synthesis_written_0", this.notes.get(node.id)?.title ?? ""), previous);
            if (observer?.isOpen()) observer.written?.();
          },
          fail,
          markAccepted
        );
      if (!outcome) fail(t("ui.ai_task_cancelled"));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      if (this.plugin.activeTasks.get(path) === controller) this.plugin.activeTasks.delete(path);
      this.render();
    }
  }
  /** Reopens the synthesis dialog at its waiting directions (from the Notice button), if they are still waiting. */
  private openSynthesisDirections(node: MapNode, task: unknown): void {
    const current = this.synthesisTasks.get(node.path);
    if (current !== task || current?.state !== "directions" || current.mapPath !== this.path) return;
    this.openNextStep(node);
  }
  private discardSynthesis(node: MapNode): void {
    const task = this.synthesisTasks.get(node.path);
    if (!task || task.state === "running") return;
    this.synthesisTasks.delete(node.path);
    this.render();
  }
  private retrySynthesis(node: MapNode): void {
    const task = this.synthesisTasks.get(node.path);
    if (!task || (task.state !== "failed" && task.state !== "cancelled")) return;
    void this.plugin.repo.readNote(node.path, this.map ?? undefined).then(note =>
      this.plugin.confirmAiUsage(task.options.runOnce?.model || note.model, async () => {
        await this.startSynthesis(
          node,
          { ...task.options, continuesDirections: task.step === "draft" },
          task.step === "directions" ? null : task.direction,
          message => new Notice(message),
          () => {}
        );
      })
    );
  }
  /** Multi-select synthesis: the same dialog and flow as a single topic's, over the selected topics. */
  private integrateSelected(): void {
    if (!this.map || this.multiSelected.size < 2) {
      new Notice(t("ui.select_at_least_two_topics"));
      return;
    }
    const task = this.integrationTask && this.integrationTask.mapPath === this.path ? this.integrationTask : null;
    if (task?.state === "running") {
      new Notice(t("ui.ai_running_ai"));
      return;
    }
    this.openSelectionSynthesis(task?.state === "directions" ? task : null);
  }
  /** Opens the synthesis dialog for the selected topics, or for the waiting task's topics with its directions. */
  private openSelectionSynthesis(pending: NonNullable<VisualAgentMapView["integrationTask"]> | null): void {
    if (!this.map) return;
    const nodes =
      pending?.sources ??
      [...this.multiSelected]
        .map(id => this.map!.nodes.find(node => node.id === id))
        .filter((node): node is MapNode => !!node);
    const names = nodes.map(node => this.notes.get(node.id)?.title ?? node.path);
    const selectedLabel = t("ui.reference_selected_topics_included", names.join(", "));
    const sources = this.taskSourceSettings(selectedLabel, this.map.id, selectedLabel);
    const settings = this.plugin.settings;
    new NextStepModal(
      this.app,
      "",
      0,
      0,
      this.plugin,
      async () => {},
      async () => {},
      (options, direction, failed, accepted, observer) =>
        this.startSelectionSynthesis(nodes, options, direction, failed, accepted, observer),
      undefined,
      {
        names,
        initialTitle:
          pending?.title ??
          synthesisDefaultName(resolveMapTextLanguage(this.map, this.plugin.settings.language), names),
        defaultDirection: t("ui.identify_shared_conclusions_key_differences_tradeoffs_and_ne"),
        background: this.backgroundHooks(this.selectionTaskKey()),
        fields: {
          sources,
          templates: this.templateChoices(),
          currentTemplate: this.mapDetailTemplate(settings.language).name,
          tones: this.toneChoices(),
          currentTone: this.toneLabelFor({}),
          currentStyle: this.currentStyleLabel(this.mapDetailTemplate(settings.language).id, this.effectiveToneId({})),
          ...this.outputLanguageMemory()
        },
        ...(pending
          ? { pending: { directions: pending.directions, discard: () => this.discardSelectionSynthesis() } }
          : {})
      }
    ).open();
  }
  /**
   * One step of multi-select synthesis: the AI's suggested directions (`direction === null`), then the draft. Both
   * report to the open dialog through `observer`; once it is closed the run carries on and the selection bar shows it.
   */
  private async startSelectionSynthesis(
    sources: MapNode[],
    options: TaskOptions,
    direction: string | null,
    failed: (message: string) => void,
    accepted: () => void,
    observer?: SynthesisObserver
  ): Promise<void> {
    if (!this.map || sources.length < 2) {
      failed(t("ui.select_at_least_two_topics"));
      return;
    }
    const existing = this.integrationTask && this.integrationTask.mapPath === this.path ? this.integrationTask : null;
    const step = direction === null ? "directions" : "draft";
    if (existing?.state === "running" || this.selectionStarting) {
      failed(t("ui.ai_running_ai"));
      return;
    }
    if ((step === "directions" && existing?.state === "directions") || existing?.state === "applying") {
      failed(t("ui.synthesis_pending_review_first"));
      return;
    }
    // A draft continues the waiting directions; after a failed draft only the dialog's own retry does (a fresh run does not).
    const continuing =
      step === "draft" &&
      !!existing?.directions.length &&
      (existing.state === "directions" || !!options.continuesDirections);
    const base: TaskOptions = continuing && existing ? existing.options : options;
    const title = (continuing && existing ? existing.title : options.synthesisTitle?.trim()) || existing?.title || "";
    // Held across the awaits below, so two requests for the same selection cannot both start.
    this.selectionStarting = true;
    const controller = new AbortController();
    const modalSignal = options.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    let own: NonNullable<VisualAgentMapView["integrationTask"]> | undefined;
    let progress: { end: () => void } | undefined;
    const runOptions: TaskOptions = {
      ...base,
      requirements: options.requirements || base.requirements,
      signal: controller.signal,
      onProgress: message => {
        if (this.integrationTask) this.integrationTask.progress = message;
        options.onProgress?.(message);
        this.render();
      }
    };
    let launched = false;
    const markAccepted = (): void => {
      if (launched || controller.signal.aborted) return;
      launched = true;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      observer?.accepted?.(() => controller.abort());
      accepted();
    };
    const fail = (error: unknown): void => {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
      const task = this.integrationTask;
      if (aborted && observer?.isOpen()) {
        // Stopped from the open dialog: nothing was produced, so no badge stays behind.
        if (own && this.integrationTask === own) this.integrationTask = null;
        this.render();
        failed(t("ui.research_stopped_existing_content_was_preserved"));
        return;
      }
      if (task) {
        task.state = aborted ? "cancelled" : "failed";
        task.progress = aborted
          ? t("ui.research_stopped_existing_content_was_preserved")
          : error instanceof Error
            ? error.message
            : String(error);
        this.render();
      }
      failed(
        aborted
          ? t("ui.research_stopped_existing_content_was_preserved")
          : this.plugin.recordFailure(
              t(step === "draft" ? "log.child_integration_failed" : "log.integration_directions_failed"),
              error
            )
      );
    };
    try {
      const chosen = await this.selectionModel(sources);
      if (step === "draft") {
        await this.createIntegratedNode(title, sources, direction ?? "", "", runOptions, {
          model: chosen,
          observer,
          accepted: markAccepted,
          controller,
          directions: continuing && existing ? existing.directions : []
        });
        markAccepted();
        return;
      }
      const sourceGroup = await this.topicReferenceGroup(
        sources,
        base.synthesisContent === "summary" ? "summary" : "strong",
        { language: runOptions.outputLanguage }
      );
      const task: NonNullable<VisualAgentMapView["integrationTask"]> = {
        title,
        goal: "",
        rules: "",
        sources,
        options: { ...runOptions, signal: undefined, onProgress: undefined },
        mapPath: this.path,
        mapId: this.map.id,
        sourceContent: JSON.stringify(sourceGroup.documents),
        controller,
        state: "running",
        step: "directions",
        directions: [],
        progress: "",
        model: chosen.model,
        reasoning: chosen.reasoning
      };
      this.integrationTask = task;
      own = task;
      this.render();
      const taskProgress = this.startTaskProgress(this.taskProgressKey("integration"), chosen.model);
      progress = taskProgress;
      const language = this.plugin.settings.language;
      const result = await this.plugin.askModel(
        {
          title,
          summary: translateNote(runOptions.outputLanguage ?? language, "note.no_conclusion_yet"),
          rules: "",
          detail: "",
          task: [synthesisDirectionsTask(runOptions.outputLanguage ?? language), runOptions.requirements]
            .filter(Boolean)
            .join("\n\n"),
          ancestors: "",
          referenceGroups: [...(runOptions.referenceGroups ?? []), sourceGroup],
          // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
          referenceDelivery: "direct",
          onProgress: runOptions.onProgress,
          outputLanguage: runOptions.outputLanguage,
          ...this.toneField(undefined, runOptions),
          mode: "synthesize",
          researchMode: runOptions.researchMode,
          researchDepth: runOptions.researchDepth,
          visualMode: "off"
        },
        chosen.model,
        chosen.reasoning,
        controller.signal,
        undefined,
        markAccepted,
        undefined,
        taskProgress.observer
      );
      taskProgress.end();
      markAccepted();
      if (this.integrationTask !== task) return;
      if (controller.signal.aborted || this.path !== task.mapPath || this.map?.id !== task.mapId)
        throw new DOMException("Aborted", "AbortError");
      const latest = await this.topicReferenceGroup(
        sources,
        base.synthesisContent === "summary" ? "summary" : "strong",
        { language: runOptions.outputLanguage }
      );
      if (JSON.stringify(latest.documents) !== task.sourceContent)
        throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      const angles = result.suggestions.slice(0, 2);
      if (!angles.length) {
        this.integrationTask = null;
        this.render();
        failed(t("ui.ai_did_not_suggest_a_synthesis_direction_please_retry"));
        return;
      }
      task.state = "directions";
      task.directions = angles;
      this.render();
      if (observer?.isOpen() && observer.directions) observer.directions(angles);
      else
        backgroundResultNotice(t("ui.background_synthesis_directions_ready"), {
          label: t("ui.choose_synthesis_direction"),
          open: () => {
            if (this.integrationTask === task && task.state === "directions") this.openSelectionSynthesis(task);
          }
        });
    } catch (error) {
      fail(error);
    } finally {
      progress?.end();
      this.selectionStarting = false;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      this.render();
    }
  }
  private discardSelectionSynthesis(): void {
    const task = this.integrationTask;
    if (!task || task.state === "running") return;
    this.integrationTask = null;
    this.render();
  }
  private retrySelectionSynthesis(task: NonNullable<VisualAgentMapView["integrationTask"]>): void {
    if (task.state !== "failed" && task.state !== "cancelled") return;
    // The stored options may carry the stopped run's aborted signal; a retry must start with its own.
    const { signal: _staleSignal, onProgress: _staleProgress, ...retained } = task.options;
    void this.selectionModel(task.sources)
      .then(chosen =>
        this.plugin.confirmAiUsage(chosen.model, async () => {
          await this.startSelectionSynthesis(
            task.sources,
            { ...retained, synthesisTitle: task.title, continuesDirections: task.directions.length > 0 },
            task.step === "directions" ? null : task.goal,
            message => new Notice(message),
            () => {}
          );
        })
      )
      .catch(error => new Notice(errorMessage(error)));
  }
  /**
   * The model for a run over several cards: when every card has the same manual model (its own or an ancestor's) that
   * model, else the current model. The reasoning follows the override only when all of them agree on it too.
   */
  private async selectionModel(nodes: MapNode[]): Promise<ModelChoice> {
    const settings = this.plugin.settings;
    const current: ModelChoice = {
      model: settings.cliModel?.trim() || FALLBACK_MODEL,
      reasoning: normalizeReasoningLevel(settings.cliReasoning)
    };
    if (!nodes.length) return current;
    const resolved = await Promise.all(
      nodes.map(node => this.plugin.repo.resolveTopicModel(node.path, this.map ?? undefined))
    );
    const first = resolved[0];
    if (!resolved.every(item => item.origin === "override" && item.model === first.model)) return current;
    return {
      model: first.model,
      reasoning: resolved.every(item => item.reasoning === first.reasoning) ? first.reasoning : current.reasoning
    };
  }
  private async topicReferenceGroup(
    sources: Pick<MapNode, "path">[],
    mode: "strong" | "summary" = "strong",
    /** `origin: false` leaves each note's Thinking Origin out (an AI merge never sends it). */
    options: { origin?: boolean; language?: ContentLanguage } = {}
  ): Promise<ReferenceGroup> {
    const language = options.language ?? this.plugin.settings?.language ?? "zh-TW";
    const notes = await Promise.all(
      sources.map(source => this.plugin.repo.readNote(source.path, this.map ?? undefined))
    );
    const documents = sources.map((source, index) => {
      const note = notes[index];
      const finding = note.newFindings.trim();
      const visuals = [note.visualReferences.trim(), imageReferencesFromMarkdown(note.detail)]
        .filter(Boolean)
        .join("\n\n");
      const content = [
        `${labelCurrentSummary(language)}: ${summaryForPrompt(note.summary, language) || translateNote(noteLanguageOf(language), "detail.no_conclusion_yet")}`,
        visuals ? `${labelVisualReferences(language)}\n${visuals}` : "",
        mode === "strong" && note.detail.trim() ? `${labelFullKnowledge(language)}\n${note.detail.trim()}` : "",
        finding ? `${labelOldFindings(language)} ${finding}` : "",
        note.thinkingOrigin && options.origin !== false ? thinkingOriginDocumentBlock(note.thinkingOrigin) : ""
      ]
        .filter(Boolean)
        .join("\n\n");
      return { path: source.path, content };
    });
    return {
      id: `mind-map:${this.map?.id ?? "selected"}`,
      name: t("ui.selected_mind_map_notes"),
      location: this.path,
      documents
    };
  }
  private async createIntegratedNode(
    title: string,
    sources: MapNode[],
    goal: string,
    rules: string,
    options?: TaskOptions,
    flow?: {
      observer?: SynthesisObserver;
      accepted?: () => void;
      controller?: AbortController;
      directions?: Suggestion[];
      model?: ModelChoice;
    }
  ): Promise<void> {
    if (!this.map || sources.length < 2) return;
    const chosen = flow?.model ?? (await this.selectionModel(sources));
    const controller = flow?.controller ?? new AbortController();
    const mapPath = this.path,
      mapId = this.map.id;
    const sourceGroup = await this.topicReferenceGroup(
      sources,
      options?.synthesisContent === "summary" ? "summary" : "strong",
      { language: options?.outputLanguage }
    );
    const task: NonNullable<VisualAgentMapView["integrationTask"]> = {
      title,
      goal,
      rules,
      sources,
      options: options
        ? { ...options, signal: undefined, onProgress: undefined }
        : { researchMode: "local", researchDepth: "normal", visualMode: "off" },
      mapPath,
      mapId,
      sourceContent: JSON.stringify(sourceGroup.documents),
      controller,
      state: "running",
      step: "draft",
      directions: flow?.directions ?? [],
      progress: "",
      model: chosen.model,
      reasoning: chosen.reasoning
    };
    this.integrationTask = task;
    this.render();
    const progress = this.startTaskProgress(this.taskProgressKey("integration"), chosen.model);
    const model = chosen.model;
    const language = this.plugin.settings.language;
    const detailTemplate = this.mapDetailTemplate(options?.outputLanguage ?? language, options?.detailTemplateId);
    try {
      const integrationContext: TaskContext = {
        title,
        summary: translateNote(options?.outputLanguage ?? language, "note.no_conclusion_yet"),
        rules: "",
        detail: "",
        task: [goal, options?.requirements].filter(Boolean).join("\n\n"),
        ancestors: "",
        referenceGroups: [...(options?.referenceGroups ?? []), sourceGroup],
        // Within budget the sources go in as written (one request); only over-budget sources are extracted first.
        referenceDelivery: "direct",
        onProgress: message => {
          if (this.integrationTask !== task) return;
          task.progress = message;
          options?.onProgress?.(message);
          this.render();
        },
        outputLanguage: options?.outputLanguage,
        ...this.toneField(undefined, options),
        mode: "synthesize",
        researchMode: options?.researchMode ?? "local",
        researchDepth: options?.researchDepth ?? "normal",
        visualMode: options?.visualMode ?? "auto",
        detailTemplate,
        addCharts: true
      };
      const result = await this.plugin.askModel(
        integrationContext,
        model,
        chosen.reasoning,
        controller.signal,
        undefined,
        flow?.accepted,
        undefined,
        progress.observer
      );
      // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
      progress.end();
      if (this.integrationTask !== task) return;
      if (controller.signal.aborted || this.path !== mapPath || this.map?.id !== mapId)
        throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
      const latest = await this.topicReferenceGroup(
        sources,
        options?.synthesisContent === "summary" ? "summary" : "strong",
        { language: options?.outputLanguage }
      );
      if (JSON.stringify(latest.documents) !== task.sourceContent)
        throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      // The result is written directly (no draft review). The fences above and in saveIntegratedNode (stop, stale
      // sources, map switch, view closed) leave every failure with zero writes.
      // Stop pressed while the sources were re-read still wins: nothing is written.
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (this.closed) throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
      task.state = "applying";
      this.render();
      const previous = this.history.undoEntry;
      const write = (): Promise<void> =>
        this.saveIntegratedNode(
          title,
          sources,
          goal,
          rules,
          model,
          result,
          options?.outputLanguage ?? language,
          task,
          integrationContext
        );
      await (flow ? this.plugin.mutate(write) : write());
      this.undoNotice(t("ui.synthesis_new_topic_0", title), previous);
      if (flow?.observer?.isOpen()) flow.observer.written?.();
    } catch (error) {
      if (this.integrationTask !== task) return;
      if (flow && controller.signal.aborted && flow.observer?.isOpen()) {
        // Stopped from the open dialog: nothing was produced, so no badge stays behind.
        if (task.directions.length) task.state = "directions";
        else this.integrationTask = null;
        this.render();
        throw error;
      }
      task.state = controller.signal.aborted ? "cancelled" : "failed";
      task.progress = controller.signal.aborted
        ? t("ui.research_stopped_existing_content_was_preserved")
        : error instanceof Error
          ? error.message
          : String(error);
      this.render();
      if (!controller.signal.aborted) throw error;
    } finally {
      progress.end();
    }
  }
  private async saveIntegratedNode(
    title: string,
    sources: MapNode[],
    goal: string,
    rules: string,
    model: string,
    result: AiResult,
    language: ContentLanguage,
    task: NonNullable<VisualAgentMapView["integrationTask"]>,
    context: TaskContext
  ): Promise<void> {
    if (
      !this.map ||
      this.integrationTask !== task ||
      this.closed ||
      task.controller.signal.aborted ||
      this.path !== task.mapPath ||
      this.map.id !== task.mapId ||
      task.state !== "applying"
    )
      throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    const latest = await this.topicReferenceGroup(
      sources,
      task.options.synthesisContent === "summary" ? "summary" : "strong",
      { language: task.options.outputLanguage }
    );
    if (
      JSON.stringify(latest.documents) !== task.sourceContent ||
      sources.some(source => !this.map?.nodes.some(node => node.id === source.id && node.path === source.path))
    )
      throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    const integrated = await this.plugin.repo.createNote(
      sanitizeGeneratedTitle(title),
      model,
      this.map,
      this.path,
      "workspace"
    );
    const detailTemplate = this.mapDetailTemplate(language, task.options.detailTemplateId);
    try {
      await this.plugin.repo.updateNote(
        integrated.path,
        {
          summary: result.summary,
          detail: canonicalDetail(result.detail, noteLanguageOf(language), detailTemplate),
          visualReferences: visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language)),
          prompt: goal,
          sourcePaths: sources.map(source => source.path),
          status: "completed",
          ...formatIssuesPatch(result.formatIssues, this.plugin.settings.language)
        },
        { detailTemplate }
      );
      integrated.parentId = null;
      integrated.x = Math.max(...sources.map(node => node.x)) + 340;
      integrated.y = sources.reduce((sum, node) => sum + node.y, 0) / sources.length;
      const previousEntry = this.history.undoEntry;
      try {
        await this.mapChangeSnapshots(
          map => {
            map.nodes.push(integrated);
          },
          true,
          [integrated.path]
        );
      } finally {
        // Also when the rebuild failed after the entry was pushed: the entry keeps its label.
        const pushed = this.history.undoEntry;
        if (pushed && pushed !== previousEntry) pushed.label = t("ui.confirm_new_synthesis_topic");
      }
      this.integrationTask = null;
      this.selected = integrated.id;
      this.multiSelected.clear();
      this.integrationMode = false;
      await this.hydrate();
      this.render();
      this.focusNode(integrated);
      try {
        // Best effort: a note that was written is never put at risk by the diagram step.
        const savedNote = await this.plugin.repo.readNote(integrated.path, this.map ?? undefined);
        this.queueCharts({
          path: integrated.path,
          saved: savedNote,
          context,
          detail: savedNote.detail,
          formatIssues: result.formatIssues,
          model,
          language,
          template: detailTemplate
        });
      } catch (error) {
        console.warn("Visual Agent Map chart step", error);
      }
    } catch (error) {
      const disk = await this.plugin.repo.readMap(this.path);
      if (!disk.nodes.some(node => node.id === integrated.id)) {
        const parked = await this.plugin.repo.moveUnique(
          integrated.path,
          this.plugin.repo.topicFolder(this.path, "Unassigned")
        );
        await this.plugin.repo.setLifecycle(parked, disk.id, "", "unassigned");
        await this.plugin.rebuildDerivedData();
      } else {
        this.integrationTask = null;
        this.map = disk;
        this.selected = integrated.id;
        this.multiSelected.clear();
        this.integrationMode = false;
        try {
          await this.plugin.rebuildDerivedData();
          await this.hydrate();
          this.render();
          this.focusNode(integrated);
        } catch {
          this.render();
          new Notice(t("ui.synthesis_saved_refresh_failed"));
        }
        return;
      }
      throw error;
    }
  }
  private transform(): void {
    if (!this.map || !this.stageEl) return;
    const { x, y, zoom } = this.map.viewport;
    this.stageEl.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    // Small enough that a name would only crowd the lines: the stylesheet hides every relation label on this attribute.
    if (zoom < RELATION_LABEL_MIN_ZOOM) this.stageEl.setAttribute("data-relation-labels", "hidden");
    else this.stageEl.removeAttribute("data-relation-labels");
    this.zoomLabel?.setText(`${Math.round(zoom * 100)}%`);
    this.zoomLabel?.setAttr("aria-label", t("ui.zoom_level_0_reset", `${Math.round(zoom * 100)}%`));
  }
  private saveViewport(): void {
    if (this.viewportTimer !== null) window.clearTimeout(this.viewportTimer);
    this.viewportTimer = window.setTimeout(() => {
      this.viewportTimer = null;
      this.queueViewportWrite();
    }, 250);
  }
  /** A viewport write skips the re-read of every note; saves that arrive while one waits in the queue join it. */
  private queueViewportWrite(): void {
    if (this.viewportQueued) return;
    this.viewportQueued = true;
    void this.plugin
      .mutate(
        async () => {
          this.viewportQueued = false;
          await this.persistViewport();
        },
        { sync: false }
      )
      .catch(() => {
        this.viewportQueued = false;
      });
  }
  /** Pan/zoom writes only the viewport onto the current file, never this view's possibly older map copy. */
  private async persistViewport(): Promise<void> {
    if (this.builtIn || !this.map || !this.path) return;
    const viewport = { ...this.map.viewport };
    const written = await this.plugin.repo.updateMap(this.path, map => {
      map.viewport = viewport;
    });
    // The write may stamp a derived field (legacy AIM content language); adopt it so the next change sees no conflict.
    const stamped = written?.aim?.contentLanguage;
    if (stamped !== undefined && this.map?.aim && this.map.aim.contentLanguage === undefined)
      this.map.aim.contentLanguage = stamped;
    const stampedOutput = written?.outputLanguage;
    if (stampedOutput !== undefined && this.map && this.map.outputLanguage === undefined)
      this.map.outputLanguage = stampedOutput;
  }
  private markCanvasHintSeen(): void {
    if (this.plugin.settings.canvasHintSeen) return;
    this.plugin.settings.canvasHintSeen = true;
    void this.plugin.saveSettings();
    if (this.integrationMode) return;
    this.hintEl?.remove();
    this.hintEl = null;
  }
  private zoomBy(factor: number, point?: { x: number; y: number }): void {
    if (!this.map || !this.viewportEl) return;
    const center = point ?? { x: this.viewportEl.clientWidth / 2, y: this.viewportEl.clientHeight / 2 },
      v = this.map.viewport;
    const zoom = Math.min(2, Math.max(0.25, v.zoom * factor)),
      ratio = zoom / v.zoom;
    v.x = center.x - (center.x - v.x) * ratio;
    v.y = center.y - (center.y - v.y) * ratio;
    v.zoom = zoom;
    this.transform();
    this.saveViewport();
  }
  /**
   * Drag-selects topics. `marquee-add` adds every card the box touches (existing picks stay); `marquee-subtract` removes
   * them; `marquee-enter` is the normal-mode Shift+drag: boxed cards are selected and topic selection starts, and a box
   * that touches nothing changes nothing.
   */
  private startMarquee(
    viewport: HTMLElement,
    event: PointerEvent,
    mode: "marquee-enter" | "marquee-add" | "marquee-subtract" = "marquee-add"
  ): void {
    const host = viewport.getBoundingClientRect();
    const startX = event.clientX,
      startY = event.clientY;
    const already = new Set(this.multiSelected);
    const cards = Array.from(this.stageEl?.querySelectorAll<HTMLElement>(".vam-node[data-node-id]") ?? []).map(
      card => ({
        card,
        id: card.dataset.nodeId ?? "",
        rect: card.getBoundingClientRect()
      })
    );
    const box = viewport.createDiv("vam-marquee");
    box.setAttr("aria-hidden", "true");
    viewport.setPointerCapture(event.pointerId);
    viewport.addClass("is-marquee");
    let hits = new Set<string>();
    const move = (e: PointerEvent): void => {
      const left = Math.min(startX, e.clientX),
        right = Math.max(startX, e.clientX),
        top = Math.min(startY, e.clientY),
        bottom = Math.max(startY, e.clientY);
      box.style.left = `${left - host.left}px`;
      box.style.top = `${top - host.top}px`;
      box.style.width = `${right - left}px`;
      box.style.height = `${bottom - top}px`;
      const dragged = right - left > 3 || bottom - top > 3;
      hits = new Set();
      for (const item of cards) {
        const hit =
          dragged &&
          !!item.id &&
          item.rect.left < right &&
          item.rect.right > left &&
          item.rect.top < bottom &&
          item.rect.bottom > top;
        if (hit) hits.add(item.id);
        // Removal is outlined differently (dashed) so it never reads as an addition by colour alone.
        if (mode === "marquee-subtract") item.card.toggleClass("is-marquee-remove", hit && already.has(item.id));
        else item.card.toggleClass("is-marquee-hit", hit && !already.has(item.id));
      }
    };
    const up = (): void => {
      viewport.removeEventListener("pointermove", move);
      viewport.removeEventListener("pointerup", up);
      viewport.removeEventListener("pointercancel", up);
      viewport.removeClass("is-marquee");
      box.remove();
      for (const item of cards) {
        item.card.removeClass("is-marquee-hit");
        item.card.removeClass("is-marquee-remove");
      }
      if (!hits.size) return;
      if (mode === "marquee-subtract") {
        const removed = [...hits].filter(id => this.multiSelected.has(id));
        if (!removed.length) return;
        for (const id of removed) this.multiSelected.delete(id);
        this.commitSelection(this.selected, this.selected, removed);
        return;
      }
      for (const id of hits) this.multiSelected.add(id);
      if (mode === "marquee-enter") {
        this.integrationMode = true;
        if (!this.closed) this.render();
        return;
      }
      this.commitSelection(this.selected, this.selected, hits);
    };
    viewport.addEventListener("pointermove", move);
    viewport.addEventListener("pointerup", up);
    viewport.addEventListener("pointercancel", up);
  }
  /** Safe area under the floating toolbar, measured so a wrapped toolbar is covered too. */
  private canvasInset(): number {
    const canvas = this.viewportEl?.getBoundingClientRect?.();
    const tools = this.contentEl?.querySelector<HTMLElement>(".vam-map-tools")?.getBoundingClientRect?.();
    return canvas ? insetFromRects(canvas.top, tools) : 0;
  }
  /** Lifts a never-moved default viewport below the toolbar. In memory only; it is saved with the next real pan or zoom. */
  private applyInitialViewport(): void {
    if (!this.map) return;
    this.map.viewport = initialViewport(this.map.viewport, this.canvasInset());
  }
  /** `persist` false is keyboard navigation: the camera follows in memory and Map.md is not written. */
  private focusNode(target: MapNode, persist = true): void {
    if (!this.map || !this.viewportEl) return;
    // Centre on where the card is drawn, which differs from its saved position while sorted by relevance.
    const node = this.relevanceSortOn() ? (this.canvasNodes().find(item => item.id === target.id) ?? target) : target;
    this.map.viewport = focusViewport(
      this.map.viewport,
      { x: node.x + 140, y: node.y + 80 },
      { width: this.viewportEl.clientWidth, height: this.viewportEl.clientHeight },
      this.canvasInset()
    );
    this.transform();
    if (persist) this.saveViewport();
  }
  private fit(): void {
    if (!this.map || !this.viewportEl) return;
    const nodes = this.canvasNodes();
    if (!nodes.length) return;
    const minX = Math.min(...nodes.map(n => n.x)),
      maxX = Math.max(...nodes.map(n => n.x + 280));
    const minY = Math.min(...nodes.map(n => n.y)),
      maxY = Math.max(
        ...nodes.map(
          n =>
            n.y +
            (this.stageEl?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(n.id)}"]`)?.offsetHeight ?? 180)
        )
      );
    this.map.viewport = fitViewport(
      { minX, minY, maxX, maxY },
      { width: this.viewportEl.clientWidth, height: this.viewportEl.clientHeight },
      this.canvasInset()
    );
    this.transform();
    this.saveViewport();
  }
  private setupPan(): void {
    const viewport = this.viewportEl!;
    viewport.addEventListener(
      "wheel",
      event => {
        event.preventDefault();
        // The hint teaches drag and wheel; it goes once the user has used one of them (a zoom button does not count).
        this.markCanvasHintSeen();
        const rect = viewport.getBoundingClientRect();
        this.zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 0 ? 0.002 : 0.04)), {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        });
      },
      { passive: false }
    );
    viewport.addEventListener("pointerdown", event => {
      const target = event.target as Element;
      // A frame's label chip is its own target: panning would capture the pointer and retarget its double-click.
      if (
        target.closest(".vam-node") ||
        target.closest(".vam-boundary-label") ||
        target.closest(INTERACTIVE_SELECTOR) ||
        !this.map
      )
        return;
      // Normal mode: a drag pans, Shift+drag draws a selection box. Topic selection mode: a drag adds to the selection,
      // Option (Alt)+drag removes from it, and Space+drag or the middle button pans.
      const intent = canvasPointerIntent({
        button: event.button,
        integrationMode: this.integrationMode,
        spaceHeld: this.spaceHeld,
        altKey: event.altKey,
        // The read-only sample and AIM maps have no topic selection, so Shift+drag there is a plain pan.
        shiftKey: event.shiftKey && this.canSelectTopics()
      });
      if (intent === "marquee-enter" || intent === "marquee-add" || intent === "marquee-subtract") {
        this.startMarquee(viewport, event, intent);
        return;
      }
      if (intent !== "pan") return;
      if (event.button === 1) event.preventDefault();
      const x = event.clientX,
        y = event.clientY,
        origin = { ...this.map.viewport };
      let moved = false;
      viewport.setPointerCapture(event.pointerId);
      viewport.addClass("is-panning");
      const move = (e: PointerEvent): void => {
        moved ||= Math.hypot(e.clientX - x, e.clientY - y) > 3;
        this.map!.viewport.x = origin.x + e.clientX - x;
        this.map!.viewport.y = origin.y + e.clientY - y;
        this.transform();
      };
      const up = (): void => {
        viewport.removeEventListener("pointermove", move);
        viewport.removeEventListener("pointerup", up);
        viewport.removeEventListener("pointercancel", up);
        viewport.removeClass("is-panning");
        this.saveViewport();
        if (moved) this.markCanvasHintSeen();
        if (!moved && event.button === 0 && this.selectedRelation) {
          this.selectedRelation = null;
          this.syncRelationClasses();
        }
        if (!moved && !this.integrationMode && event.button === 0) {
          const previous = this.selected,
            touched = [...this.multiSelected];
          this.selected = null;
          this.multiSelected.clear();
          this.commitSelection(previous, null, touched);
        }
      };
      viewport.addEventListener("pointermove", move);
      viewport.addEventListener("pointerup", up);
      viewport.addEventListener("pointercancel", up);
    });
  }
  // ---- AI chat window -------------------------------------------------------------------------------------------
  /** Before a repaint: takes the chat window out of the page and returns what gives its text field focus back after it. */
  private detachMapChat(): () => void {
    const restore = this.chat?.captureFocus() ?? ((): void => {});
    this.chat?.detach();
    return restore;
  }
  /**
   * Puts the chat window into this repaint. Normally it is the first child of `workspace`, the window left of the canvas. On an
   * empty map (and on the read-only sample) with no conversation yet it is the opening screen instead, in the middle of the
   * canvas (or in the sample's start card). The window itself (messages, draft, chips) lives on the view.
   */
  private mountMapChat(workspace: HTMLElement, overlay: HTMLElement): void {
    this.chatWorkspaceEl = workspace;
    this.chatOverlayEl = overlay;
    if (!this.map) return;
    if (!this.chat) {
      this.chat = new MapChatPanel(this.chatHost());
      this.chat.restoreOpen(normalizeMapChatOpen(this.plugin.settings.mapChatOpen));
    }
    if (this.chatMapId !== this.map.id) {
      if (this.chatCarryOver) {
        // The conversation opened this map itself (create_map, open_map): it goes along and its running turn goes on.
        this.chatMapId = this.map.id;
      } else {
        // Another map opened some other way: the conversation belongs to the one it was about.
        this.abortMapChat();
        this.chatPlanToken++;
        this.chat.reset();
        this.chatMapId = this.map.id;
      }
    }
    this.syncChatNarrow();
    this.placeChatPanel();
    // A press on the canvas puts a window that was laid over it back to the edge.
    this.viewportEl?.addEventListener("pointerdown", () => this.chat?.collapseOverlay());
    workspace.toggleClass("has-map-chat-open", this.chat.isOpen);
    this.focusChatHeroOnce();
  }
  /** Whether the opening screen is showing: nothing said yet, and an empty map (not an AIM one) or the read-only sample. */
  private chatHero(): boolean {
    if (!this.chat || this.chat.hasMessages || !this.map) return false;
    return this.builtIn || (!this.map.aim && this.map.nodes.length === 0);
  }
  /** Mounts the panel where it belongs now: the opening screen's place, or the first child of the workspace. */
  private placeChatPanel(): void {
    const chat = this.chat;
    const workspace = this.chatWorkspaceEl;
    const overlay = this.chatOverlayEl;
    if (!chat || !workspace || !overlay) return;
    if (!this.chatHero()) {
      chat.mount(workspace, "side");
      return;
    }
    // The sample keeps its map in view: the opening screen sits in the sample's own start card. An empty map has the whole canvas.
    const startCard = this.builtIn ? this.contentEl.querySelector<HTMLElement>(".vam-sample-start-chat") : null;
    const slot = startCard ?? overlay.createDiv("vam-chat-hero-slot");
    chat.mount(slot, "hero");
    this.viewportEl?.toggleClass("has-chat-hero", !startCard);
  }
  /** True while the first message forces the window open: that is not the user's choice, so it is not saved. */
  private chatForcedOpen = false;
  /** The first message was sent (or a conversation ended): the panel moves between the opening screen and the window. */
  private relocateMapChat(): void {
    const chat = this.chat;
    if (!chat || this.closed) return;
    const hero = chat.isHero;
    if (hero === this.chatHero()) return;
    const restore = this.detachMapChat();
    this.contentEl.querySelectorAll<HTMLElement>(".vam-chat-hero-slot").forEach(slot => slot.remove());
    this.viewportEl?.removeClass("has-chat-hero");
    this.placeChatPanel();
    // The window the first message moves into is shown even when it was folded or closed: the conversation just began in it.
    // This is not the user's choice, so it is not remembered (see layoutChanged).
    this.chatForcedOpen = true;
    try {
      if (!chat.isOpen) chat.setOpen(true, true);
    } finally {
      this.chatForcedOpen = false;
    }
    this.chatWorkspaceEl?.toggleClass("has-map-chat-open", chat.isOpen);
    restore();
    this.placeMapTools();
  }
  /** Opening screen: the keyboard starts in the message field, once per map, unless it is in another pane. */
  private focusChatHeroOnce(): void {
    const chat = this.chat;
    if (!chat?.isHero || !this.map || this.chatHeroFocusedFor === this.map.id) return;
    this.chatHeroFocusedFor = this.map.id;
    const active = this.contentEl.ownerDocument?.activeElement ?? null;
    if (!active || active === this.contentEl.ownerDocument?.body || this.contentEl.contains(active)) chat.focusInput();
  }
  /** The pane's width and what the sample's inspector takes of it; null while the pane has no size yet (not shown, or a test). */
  private chatPaneWidths(): { pane: number; inspector: number } | null {
    const pane = this.contentEl?.clientWidth;
    if (!pane) return null;
    const inspector = this.contentEl.querySelector<HTMLElement>(".vam-inspector");
    return { pane, inspector: inspector?.offsetWidth ?? 0 };
  }
  /** What the pane gives the window for a set width: docked beside the canvas, or laid over a narrow pane. */
  private chatWidths(setWidth: number): { docked: number; overlay: number } | null {
    const measured = this.chatPaneWidths();
    if (!measured) return null;
    return {
      docked: chatDockedWidth(measured.pane, setWidth, measured.inspector),
      overlay: chatOverlayWidth(measured.pane, setWidth)
    };
  }
  /**
   * The window folds to a narrow edge only when even its narrowest form would leave the canvas under 360px; wider than that it
   * docks and gives way in width (see chatDockedWidth). A pane on the limit keeps its state until it is a little wider.
   */
  private syncChatNarrow(): void {
    const measured = this.chatPaneWidths();
    if (!this.chat || !measured) return;
    const widths = this.chatWidths(this.chatWidth());
    if (!widths) return;
    this.chat.setNarrow(isChatNarrow(measured.pane, measured.inspector, this.chat.isNarrow), widths);
    this.placeMapTools();
  }
  /**
   * The tool group sits at the top left of the canvas. While the window is laid over a narrow pane it would be under the window,
   * so it moves to the window's right edge, as it sits beside a docked window.
   */
  private placeMapTools(): void {
    const tools = this.contentEl?.querySelector<HTMLElement>(".vam-map-tools");
    if (!tools) return;
    // The canvas starts after the 44px edge the laid-over window leaves in place.
    const left = this.chat?.isOverlay ? this.chat.overlayWidth - CHAT_RAIL_WIDTH + CHAT_TOOLS_GAP : 0;
    tools.style.left = left > 0 ? `${left}px` : "";
  }
  /** Obsidian calls this when the pane's size changes. */
  onResize(): void {
    this.syncChatNarrow();
    this.fitKindShapes();
  }
  private chatWidth(): number {
    return clampMapChatWidth(this.plugin.settings.mapChatWidth);
  }
  /** The command that opens or closes the chat window and leaves the keyboard in its message field. */
  toggleMapChat(): void {
    if (!this.chat) return;
    this.chat.toggleFromCommand();
  }
  /** Asks for a name, then makes and opens an empty map. No AI. */
  private promptEmptyMap(): void {
    new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title =>
      this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))
    ).open();
  }
  private chatHost(): MapChatHost {
    const emptyMap = (): (() => void) | undefined => (this.builtIn ? undefined : () => this.promptEmptyMap());
    return {
      // The built-in sample's start card already has this button; read each time, the view can switch to the sample.
      get createEmptyMap() {
        return emptyMap();
      },
      topicTitle: id => {
        const node = this.map?.nodes.find(item => item.id === id);
        return node ? (this.notes.get(id)?.title ?? node.path) : null;
      },
      selectedIds: () => this.chatSelectionIds(),
      send: () => {
        void this.sendMapChat();
      },
      stop: () => this.stopMapChat(),
      style: () => normalizeMapChatStyle(this.plugin.settings.mapChatStyle),
      setStyle: style => {
        this.plugin.settings.mapChatStyle = style;
        void this.plugin.saveSettings();
      },
      modelChoices: () => this.chatModelChoices(),
      model: () => this.plugin.settings.cliModel,
      setModel: model => {
        void this.plugin.setCurrentModel(model);
      },
      watchModels: changed => {
        const stopDiscovery = this.plugin.subscribeModelDiscovery(changed);
        const stopCurrent = this.plugin.subscribeCurrentModel(changed);
        void this.plugin.refreshModelDiscovery("codex");
        void this.plugin.refreshModelDiscovery("claude");
        return () => {
          stopDiscovery();
          stopCurrent();
        };
      },
      moreDetail: origin => {
        void this.sendMapChat(origin);
      },
      retry: origin => {
        void this.sendMapChat(origin, true);
      },
      resolveLink: link => {
        const file = this.app.metadataCache.getFirstLinkpathDest(link, this.sourceMarkdownFile()?.path ?? "");
        return file && file.extension === "md" ? file.path : null;
      },
      activeNotePath: () => this.sourceMarkdownFile()?.path ?? null,
      visibleNotePath: () => this.visibleMarkdownFile()?.path ?? null,
      openLink: (href, newLeaf) => {
        void this.app.workspace.openLinkText(href, this.path, newLeaf);
      },
      activeElement: () => this.contentEl.ownerDocument?.activeElement ?? null,
      layoutChanged: () => {
        const chat = this.chat;
        this.chatWorkspaceEl?.toggleClass("has-map-chat-open", !!chat?.isOpen);
        this.placeMapTools();
        // Only what the user chose is remembered, not the fold a narrow pane forces on the window.
        if (chat && !chat.isHero && !this.chatForcedOpen && this.plugin.settings.mapChatOpen !== chat.wantsOpen) {
          this.plugin.settings.mapChatOpen = chat.wantsOpen;
          void this.plugin.saveSettings();
        }
      },
      width: () => this.chatWidth(),
      widths: setWidth => this.chatWidths(setWidth),
      stateChanged: () => this.refreshEmptyMap(),
      setWidth: (width, commit) => {
        if (!commit) return;
        this.plugin.settings.mapChatWidth = clampMapChatWidth(width);
        void this.plugin.saveSettings();
        // The width decides whether the pane has room for the window beside the canvas.
        this.syncChatNarrow();
      },
      suggestions: () => ({
        selected: this.chatSelectionIds().length,
        hasTopics: (this.map?.nodes.length ?? 0) > 0
      }),
      insertImage: (images, item) => this.chatInsertImage(images, item),
      canSave: () =>
        this.builtIn || !this.map ? { ok: false, reason: t("ui.map_chat_save_unavailable") } : { ok: true },
      saveTranscript: turns => this.saveChatTranscript(turns)
    };
  }
  /** The chat's model list: the settings page's list, plus the current model when it has gone from that list. */
  private chatModelChoices(): { value: string; label: string; short?: string }[] {
    const current = this.plugin.settings.cliModel;
    const choices = this.plugin.availableModels().map(id => ({ value: id, label: this.plugin.modelLabel(id) }));
    if (current && !choices.some(choice => choice.value === current))
      choices.push({
        value: current,
        label: `${this.plugin.modelLabel(current)} (${t("ui.current_model_is_unavailable")})`
      });
    return choices;
  }
  /** The cards the user has selected: they count as chat references without being dragged in. */
  private chatSelectionIds(): string[] {
    if (this.multiSelected.size) return [...this.multiSelected];
    return this.selected ? [this.selected] : [];
  }
  /**
   * The note a chat message goes with: only a note that is on screen beside the map right now (the shown tab of its tab group,
   * in this map's window). Background tabs, other windows and closed notes never count. With several on screen: the one the
   * user touched last, then one of this map's own topic notes, then the first.
   */
  private visibleMarkdownFile(): TFile | null {
    const shown: string[] = [];
    const doc = this.contentEl.ownerDocument;
    for (const leaf of this.app.workspace.getLeavesOfType?.("markdown") ?? []) {
      const view = leaf.view;
      if (!(view instanceof MarkdownView) || !view.file) continue;
      const el = view.containerEl;
      if (!el || (doc && el.ownerDocument !== doc) || !el.isShown()) continue;
      if (!shown.includes(view.file.path)) shown.push(view.file.path);
    }
    const topicPaths = new Set(this.map?.nodes.map(node => node.path) ?? []);
    const candidates = [
      this.lastMarkdownPath && shown.includes(this.lastMarkdownPath) ? this.lastMarkdownPath : null,
      shown.find(path => topicPaths.has(path)),
      ...shown
    ];
    for (const path of candidates) {
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (file instanceof TFile && file.extension === "md") return file;
    }
    return null;
  }
  /**
   * Where dragged-in text most likely came from: the active note, else the one touched last (if still open), else any open
   * note, wherever it is. Only a guess for a snippet's source; what a message is sent with is {@link visibleMarkdownFile}.
   */
  private sourceMarkdownFile(): TFile | null {
    const workspace = this.app.workspace;
    const open = new Set<string>();
    for (const leaf of workspace.getLeavesOfType?.("markdown") ?? [])
      if (leaf.view instanceof MarkdownView && leaf.view.file) open.add(leaf.view.file.path);
    const live = workspace.getActiveViewOfType?.(MarkdownView)?.file?.path;
    const candidates = [
      live,
      this.lastMarkdownPath && open.has(this.lastMarkdownPath) ? this.lastMarkdownPath : null,
      ...open
    ];
    for (const path of candidates) {
      const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
      if (file instanceof TFile && file.extension === "md") return file;
    }
    return null;
  }
  private openMarkdownEditor(path: string): Editor | null {
    for (const leaf of this.app.workspace.getLeavesOfType?.("markdown") ?? [])
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) return leaf.view.editor;
    return null;
  }
  /** A vault note's text as it is right now (an open note is read from its editor, which may hold unsaved typing). */
  private async readChatFile(path: string): Promise<{ file: TFile; text: string; editor: Editor | null } | null> {
    const key = normalizeVaultPath(path);
    const file = key ? this.app.vault.getAbstractFileByPath(key) : null;
    if (!(file instanceof TFile)) return null;
    const editor = this.openMarkdownEditor(file.path);
    return { file, editor, text: editor ? editor.getValue() : await this.app.vault.read(file) };
  }
  /** What a chat turn sees of a card right now: the values the turn's baseline hashes are compared with. */
  private chatTopicState(
    id: string,
    fresh?: Note
  ): { title: string; summary: string; detail: string; parentId: string | null } | null {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!node) return null;
    const note = fresh ?? this.notes.get(id);
    const summary = note?.summary ?? "";
    return {
      title: note?.title ?? node.path,
      summary: isPlaceholder(summary) ? "" : summary,
      detail: note?.detail ?? "",
      parentId: node.parentId
    };
  }
  /** The card as the vault has it right now (the view's cache can be a debounce behind a user's edit); the cache is refreshed too. */
  private async chatTopicNow(
    id: string
  ): Promise<{ title: string; summary: string; detail: string; parentId: string | null } | null> {
    const node = this.map?.nodes.find(item => item.id === id);
    if (!node) return null;
    let fresh: Note | undefined;
    try {
      fresh = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    } catch {
      return null;
    }
    this.notes.set(id, fresh);
    return this.chatTopicState(id, fresh);
  }
  /**
   * The reason to skip a card action, or null when the card is as the model saw it. Title and parent are always compared;
   * the summary and the Detail text only when the card was sent in full. `edit_topic_note` replaces the whole body, so it
   * needs a Detail baseline: a card the model saw only in the outline is never overwritten.
   */
  private async chatTopicStale(
    id: string,
    topicHashes: Readonly<Record<string, MapChatTopicHash>>,
    needsDetail = false
  ): Promise<ChatOutcome | null> {
    const seen = Object.prototype.hasOwnProperty.call(topicHashes, id) ? topicHashes[id] : undefined;
    const now = await this.chatTopicNow(id);
    if (!seen || !now) return skipped("ui.map_chat_skip_topic_changed");
    if (needsDetail && seen.detailHash === undefined) return skipped("ui.map_chat_skip_topic_not_seen");
    if (
      seen.title !== now.title ||
      seen.parentId !== now.parentId ||
      (seen.summary !== undefined && seen.summary !== now.summary) ||
      (seen.detailHash !== undefined && seen.detailHash !== contentHash(now.detail))
    )
      return skipped("ui.map_chat_skip_topic_changed");
    return null;
  }
  /** After this reply's own write to a card, its baseline follows, so a second action in the same reply is not mistaken for a user edit. */
  private async chatTopicAccept(id: string, topicHashes: Record<string, MapChatTopicHash>): Promise<void> {
    const seen = topicHashes[id];
    const now = await this.chatTopicNow(id);
    if (!seen || !now) return;
    topicHashes[id] = {
      title: now.title,
      parentId: now.parentId,
      ...(seen.summary !== undefined ? { summary: now.summary } : {}),
      ...(seen.detailHash !== undefined ? { detailHash: contentHash(now.detail) } : {})
    };
  }
  private async buildChatRequest(
    message: string,
    chat: MapChatPanel,
    origin: MapChatOrigin,
    redo = false
  ): Promise<MapChatRequest> {
    const map = this.map!;
    const settings = this.plugin.settings;
    const byId = new Map(map.nodes.map(node => [node.id, node]));
    const summaryOf = (id: string): string => this.chatTopicState(id)?.summary ?? "";
    const titleOf = (node: MapNode): string => this.chatTopicState(node.id)?.title ?? node.path;
    const depthOf = (node: MapNode): number => {
      const seen = new Set<string>([node.id]);
      let depth = 0;
      for (let at = node.parentId; at && !seen.has(at); at = byId.get(at)?.parentId ?? null) {
        seen.add(at);
        depth++;
      }
      return depth;
    };
    const failureOf = (id: string): { status?: "error"; error?: string; retryWith?: string } => {
      const note = this.notes.get(id);
      if (note?.status !== "error") return {};
      // A provider error with another provider to offer carries that model's label (the card's own button uses the same rule).
      const node = byId.get(id);
      const target = node ? this.otherProviderTarget([node]) : null;
      return {
        status: "error",
        ...(note.lastError ? { error: note.lastError } : {}),
        ...(target ? { retryWith: this.plugin.modelLabel(target) } : {})
      };
    };
    const outline: MapChatOutlineNode[] = map.nodes.map(node => ({
      id: node.id,
      title: titleOf(node),
      summary: summaryOf(node.id),
      parentId: node.parentId,
      depth: depthOf(node),
      ...failureOf(node.id)
    }));
    const ref = (id: string): MapChatTopicRef | null => {
      const node = byId.get(id);
      return node
        ? {
            id,
            title: titleOf(node),
            summary: summaryOf(id),
            detail: this.notes.get(id)?.detail ?? "",
            path: node.path,
            ...failureOf(id)
          }
        : null;
    };
    const notNull = <T>(value: T | null): value is T => value !== null;
    const selectedIds = origin.selectedIds;
    const attached = origin.chips;
    const snippets: NonNullable<Parameters<typeof buildMapChatContext>[0]["snippets"]> = [];
    const files: NonNullable<Parameters<typeof buildMapChatContext>[0]["files"]> = [];
    for (const chip of attached) {
      if (chip.kind === "snippet") {
        const source = chip.path ? await this.readChatFile(chip.path) : null;
        snippets.push({
          path: chip.path,
          text: chip.text,
          pathGuessed: chip.pathGuessed,
          ...(source ? { fileContent: source.text } : {})
        });
      } else if (chip.kind === "file") {
        const source = await this.readChatFile(chip.path);
        if (source) files.push({ path: source.file.path, content: source.text });
      }
    }
    // Only the note the chip shows is sent; with the chip taken off nothing is, so no edit of it has a baseline.
    const activePath = chat.currentNote();
    const activeSource = activePath ? await this.readChatFile(activePath) : null;
    // Titles let the model tell "make a new map" from "go to that one"; a failure to list them only leaves the list empty.
    const mapTitles = await Promise.resolve()
      .then(() => this.plugin.repo.topics())
      .then(topics => topics.map(topic => topic.title))
      .catch(() => [] as string[]);
    const context = buildMapChatContext({
      mapTitle: map.title,
      mapTitles,
      noEditableMap: this.builtIn || !isManagedMapPath(settings, this.path),
      outline,
      selected: selectedIds.map(ref).filter(notNull),
      references: attached
        .filter((chip): chip is Extract<MapChatChip, { kind: "topic" }> => chip.kind === "topic")
        .map(chip => ref(chip.id))
        .filter(notNull)
        .filter(item => !selectedIds.includes(item.id)),
      snippets,
      files,
      activeFile: activeSource ? { path: activeSource.file.path, content: activeSource.text } : null,
      history: chat.turns()
    });
    return {
      message,
      context,
      language: settings.language,
      contentLanguage: outputLanguageForMap(map, settings.language, ...mapChatLanguageSources(message)),
      style: redo ? "detailed" : normalizeMapChatStyle(settings.mapChatStyle),
      ...(redo ? { redo: true } : {}),
      model: settings.cliModel,
      reasoning: normalizeReasoningLevel(settings.cliReasoning)
    };
  }
  /** The text of a failed turn; `wrapped` when it already says that the chat failed (so a reader is not told twice). */
  private chatErrorText(error: unknown): { text: string; wrapped: boolean } {
    const code =
      (error as { name?: unknown; code?: unknown } | null)?.name === "MapChatError"
        ? (error as { code?: unknown }).code
        : null;
    if (code === "over_budget") return { text: t("ui.map_chat_error_over_budget"), wrapped: false };
    if (code === "invalid") return { text: t("ui.map_chat_error_invalid"), wrapped: false };
    if (code === "stopped") return { text: t("ui.map_chat_stopped"), wrapped: false };
    return { text: t("ui.map_chat_error_failed_0", errorMessage(error)), wrapped: true };
  }
  /** Sends the draft: usage notice, one request, a streamed answer, then every action it asked for, once (or a plan to confirm first). */
  private async sendMapChat(again?: MapChatOrigin, retry = false): Promise<void> {
    const chat = this.chat;
    if (!chat || chat.isBusy || this.chatApplying || this.closed || !this.map) return;
    // "Say it in more detail" sends the same question with the same references again; a normal send reads the draft. A retry
    // sends the same question as it was (concise, with its actions applied), after a failure.
    const redo = Boolean(again) && !retry;
    const message = again ? again.text : chat.draft.trim();
    if (!message) return;
    const origin: MapChatOrigin = again ?? {
      text: message,
      chips: chat.attachments(),
      selectedIds: this.chatSelectionIds()
    };
    // Where this turn is anchored. A create_map / open_map of the turn itself moves it (see applyMapChatActions).
    const anchor = { path: this.path, id: this.map.id as string | undefined };
    // The press is answered at once: the messages and a "Preparing" bubble appear before the AI is checked, the request is built
    // or the usage notice is asked. Until the request really goes out, every early end takes the messages back (see `abandon`).
    const draft = chat.draft;
    const turn = chat.begin(redo ? t("ui.map_chat_more_detail_asked") : message, origin, Boolean(again), "preparing");
    let sent = false;
    // Takes the turn back and puts the draft into the field again (a "more detail" or retry has no draft to put back). `reason`
    // is the Notice; closing the view or switching maps needs none, and then the panel has already dropped the turn.
    const abandon = (reason?: string): void => {
      if (this.chatPrepAbandon === stopPreparing) this.chatPrepAbandon = null;
      if (!chat.retract(turn, again ? undefined : draft)) return;
      if (reason !== undefined) new Notice(reason);
    };
    // Stop while preparing is the user's own act: the send is taken back like any early end, without a Notice.
    const stopPreparing = (): void => abandon();
    this.chatPrepAbandon = stopPreparing;
    const notSent = (): string => t(again ? "ui.map_chat_not_sent_kept" : "ui.map_chat_not_sent_draft");
    let request: MapChatRequest;
    try {
      request = await this.buildChatRequest(message, chat, origin, redo);
    } catch (error) {
      abandon(this.closed ? undefined : errorMessage(error));
      return;
    }
    // Stop, closing the view or a map switch while the request was being built: no usage notice, no setup guide.
    if (this.closed || !chat.hasTurn(turn)) {
      abandon();
      return;
    }
    let went = false;
    try {
      went = await this.plugin.confirmAiUsage(request.model, async () => {
        // The view closed, the map changed or a plan began applying while the notice was open: nothing is sent.
        if (
          this.closed ||
          this.chatApplying ||
          !chat.hasTurn(turn) ||
          this.path !== anchor.path ||
          this.map?.id !== anchor.id
        ) {
          abandon();
          return;
        }
        sent = true;
        if (this.chatPrepAbandon === stopPreparing) this.chatPrepAbandon = null;
        // One attempt is one request to the model. "Resend" (the slow notice) replaces it with another attempt of the same
        // question: a reply that arrives from a replaced attempt changes nothing, like one that arrives after Stop.
        const openAttempt = (): { controller: AbortController; alive: () => boolean } => {
          const controller = new AbortController();
          const key = `map-chat-view:${++mapChatTaskSequence}`;
          this.chatController = controller;
          this.chatTaskKey = key;
          this.plugin.activeTasks?.set(key, controller);
          // A reply that arrives after Stop, a resend, closing the view or switching maps changes nothing.
          return {
            controller,
            alive: () =>
              !this.closed &&
              !controller.signal.aborted &&
              this.chatController === controller &&
              this.path === anchor.path
          };
        };
        let attempt = openAttempt();
        // A plan still waiting for its yes belongs to the question before this one.
        this.supersedeChatPlan();
        // The first message of a conversation moves the opening screen's panel into the side window.
        this.relocateMapChat();
        // From here the request goes out: the bubble leaves "Preparing".
        chat.setStage("waiting");
        const modelName = this.plugin.modelLabel(request.model);
        for (;;) {
          const { controller, alive } = attempt;
          // Stop came between a resend and its request: nothing more is sent.
          if (!alive()) return;
          // Set when the user presses "Resend" on this attempt; the loop then runs the next one.
          let replaced = false;
          let wake: () => void = () => undefined;
          const swapped = new Promise<void>(resolve => {
            wake = resolve;
          });
          // The slow notice: no model event for FIRST_EVENT_WAIT_MS from the start of the wait. Any model event ends the watch;
          // so does a mode where events cannot be seen at all (Claude json), where the notice would be a false alarm.
          let watching = true;
          let timer: number | null = null;
          const stopWatching = (): void => {
            watching = false;
            if (timer !== null) window.clearTimeout(timer);
            timer = null;
          };
          const modelEvent = (): void => {
            stopWatching();
            if (alive()) chat.clearSlow();
          };
          const resend = (): void => {
            // Stop wins: an attempt that was stopped or replaced already cannot be replaced again.
            if (!alive() || replaced || !watching) return;
            replaced = true;
            stopWatching();
            this.releaseChatTask();
            controller.abort();
            attempt = openAttempt();
            chat.restartWaiting();
            wake();
          };
          timer = window.setTimeout(() => {
            timer = null;
            if (watching && alive() && !replaced) chat.showSlow(t("ui.map_chat_slow_0", modelName), resend);
          }, FIRST_EVENT_WAIT_MS);
          try {
            const outcome = await Promise.race([
              this.plugin.mapChat.chat(
                request,
                controller.signal,
                text => {
                  if (!alive()) return;
                  modelEvent();
                  chat.streamReply(text);
                },
                event => {
                  if (!alive()) return;
                  if (event.kind === "stream-mode") {
                    if (event.mode !== "stream-json") stopWatching();
                    return;
                  }
                  // Claude's first event, and Codex's searching / reading / writing, are model events. Codex's `started` is not: the
                  // runtime sends it for any `item/*`, including the echo of our own prompt (`userMessage`, about 3 s in), so it
                  // proves nothing about the model. Codex text arrives through the reply callback above.
                  if (!(event.kind === "activity" && event.activity === "started")) modelEvent();
                  // Codex says it is writing before its text can be shown; Claude's first event proves nothing about the stage.
                  if (event.kind === "activity" && event.activity === "writing") chat.setStage("writing");
                }
              ),
              swapped.then(() => null)
            ]);
            stopWatching();
            if (outcome === null) continue;
            if (!alive()) return;
            const result: MapChatResult = outcome;
            // A detail re-send only explains: the actions of the first answer were applied already, so whatever it lists is dropped.
            if (redo) {
              const lines = result.actions.length
                ? [{ status: "skipped" as const, text: t("ui.map_chat_redo_actions_ignored") }]
                : [];
              if (alive() && chat.isBusy) chat.finish(result.reply, lines);
              return;
            }
            const plan = result.actions.length
              ? planFor(result.actions, request.context, {
                  diagrams: this.plugin.settings.addDiagramsAfterResearch,
                  mapAiMode: this.map?.aiMode
                })
              : null;
            if (plan) {
              // Nothing is touched until the user applies the plan.
              if (chat.isBusy) {
                chat.finish(result.reply, []);
                this.offerChatPlan(
                  result,
                  plan,
                  request.context,
                  { path: anchor.path, id: anchor.id },
                  request.message
                );
              }
              return;
            }
            // A pure answer has nothing to apply: the reader is not told "applying" for it.
            if (result.actions.length) chat.setStage("applying");
            const lines = await this.applyMapChatActions(
              { ...result, message: request.message },
              request.context,
              alive,
              anchor
            );
            if (alive() && chat.isBusy) chat.finish(result.reply, lines);
            return;
          } catch (error) {
            stopWatching();
            // The attempt that was replaced reports nothing; a later one is already running.
            if (replaced) continue;
            if (alive()) {
              const failure = this.chatErrorText(error);
              chat.fail(failure.text, failure.wrapped ? failure.text : undefined);
            }
            return;
          } finally {
            if (!replaced && this.chatController === controller) this.releaseChatTask();
          }
        }
      });
    } catch (error) {
      // Only a failure before the request went out is taken back; once sent, the turn reports its own failures.
      if (sent) throw error;
      abandon(this.closed ? undefined : errorMessage(error));
      return;
    }
    // The AI is not ready (it said why itself) or the usage notice was declined.
    if (!went && !sent) abandon(this.closed ? undefined : notSent());
  }
  /** Ends the plan waiting for an answer, if any: its buttons stop working and it reads as cancelled. */
  private supersedeChatPlan(): void {
    const pending = this.chat?.pendingPlan() ?? null;
    this.chatPlanToken++;
    if (pending) this.chat?.settlePlan(pending, "cancelled");
  }
  private planReasonText(
    reason: MapChatPlanReason,
    result: Pick<MapChatResult, "actions">,
    selectedCount: number
  ): string {
    switch (reason) {
      case "many_actions":
        return t("ui.map_chat_plan_reason_many_actions_0", result.actions.length);
      case "delete_branch":
        return t("ui.map_chat_plan_reason_delete_branch");
      case "many_research":
        // The same count the plan was judged by (a selection made earlier in the reply counts).
        return t("ui.map_chat_plan_reason_many_research_0", researchTargetsOf(result.actions, selectedCount));
      case "new_map":
        return t("ui.map_chat_plan_reason_new_map");
    }
  }
  /** Shows the plan card under the answer; only its Apply button ever writes anything. */
  private offerChatPlan(
    result: MapChatResult,
    plan: MapChatPlan,
    baseline: Pick<MapChatContext, "mdHashes" | "topicHashes" | "selectedCount">,
    anchor: { path: string; id: string | undefined },
    /** The user's message: an integration in the plan takes it as its direction when the plan is applied, as it would have at once. */
    message: string
  ): void {
    const chat = this.chat;
    if (!chat) return;
    const token = ++this.chatPlanToken;
    const refTitles = this.chatRefTitles(result.actions);
    const items = result.actions.map(action => this.chatActionLabel(action, refTitles));
    // The same lines by kind of work, so a 100-action plan reads as five folded lists.
    const groups = CHAT_PLAN_GROUP_ORDER.flatMap(group => {
      const own = items.filter((_, index) => chatPlanGroupOf(result.actions[index].kind) === group);
      return own.length
        ? [
            {
              label: t(`ui.map_chat_plan_group_${group}_0`, own.length),
              items: own,
              // Removing cards is said in words as well as in the warning colour.
              ...(group === "delete" ? { danger: { mark: t("ui.map_chat_plan_mark_delete") } } : {})
            }
          ]
        : [];
    });
    const card: MapChatPlanCard = {
      reasons: plan.reasons.map(reason => this.planReasonText(reason, result, baseline.selectedCount)),
      items,
      groups,
      estimate: plan.estimatedCalls
        ? t("ui.map_chat_plan_calls_0", plan.estimatedCalls)
        : t("ui.map_chat_plan_calls_none"),
      state: "pending",
      apply: () => void this.applyChatPlan(card, token, { ...result, message }, baseline, anchor),
      cancel: () => {
        if (token !== this.chatPlanToken) return;
        this.chatPlanToken++;
        this.chat?.settlePlan(card, "cancelled");
      }
    };
    chat.showPlan(card);
  }
  private async applyChatPlan(
    card: MapChatPlanCard,
    token: number,
    result: MapChatResult & { message?: string },
    baseline: Pick<MapChatContext, "mdHashes" | "topicHashes">,
    anchor: { path: string; id: string | undefined }
  ): Promise<void> {
    const chat = this.chat;
    if (!chat || this.closed || token !== this.chatPlanToken || chat.isBusy || this.chatApplying) return;
    // The map the plan was made for is not the one open any more: nothing is written.
    if (!this.map || this.path !== anchor.path || this.map.id !== anchor.id) {
      this.chatPlanToken++;
      chat.settlePlan(card, "cancelled", [{ status: "skipped", text: t("ui.map_chat_skip_map_changed") }]);
      return;
    }
    this.chatApplying = true;
    chat.settlePlan(card, "applied");
    // The window shows that it is working, and Stop ends the rest of the plan.
    chat.setApplying(true);
    let lines: MapChatLine[];
    try {
      lines = await this.applyMapChatActions(result, baseline, () => token === this.chatPlanToken, {
        path: anchor.path,
        id: anchor.id
      });
    } catch (error) {
      lines = [{ status: "failed", text: errorMessage(error) }];
    } finally {
      this.chatApplying = false;
      chat.setApplying(false);
    }
    if (!this.closed) chat.settlePlan(card, "applied", lines);
  }
  private releaseChatTask(): void {
    if (this.chatTaskKey) this.plugin.activeTasks?.delete(this.chatTaskKey);
    this.chatTaskKey = null;
    this.chatController = null;
  }
  /** Stop button: the request is aborted and whatever came back is dropped. */
  private stopMapChat(): void {
    // A plan being applied has no request to abort: the plan's number moves on, what is done stays and the rest is skipped.
    if (this.chatApplying && !this.chatController) {
      this.chatPlanToken++;
      this.chat?.focusInput();
      return;
    }
    const controller = this.chatController;
    if (!controller) {
      this.chatPrepAbandon?.();
      this.chat?.focusInput();
      return;
    }
    this.releaseChatTask();
    controller.abort();
    this.chat?.markStopped();
    this.chat?.focusInput();
  }
  /** Closing the view or leaving the map: abort without touching the window. */
  private abortMapChat(): void {
    this.chatPlanToken++;
    const controller = this.chatController;
    this.releaseChatTask();
    controller?.abort();
    this.abortChatImageSearches();
  }
  /** Every picture search the chat started stops; a result that still arrives is neither shown nor written. */
  private abortChatImageSearches(): void {
    const searches = [...this.chatImageSearches.values()];
    this.chatImageSearches.clear();
    for (const controller of searches) controller.abort();
  }
  /** Titles the reply gave to the cards it creates, by `new:<ref>` id, so a later action can name them before they exist. */
  private chatRefTitles(actions: readonly MapChatAction[]): Map<string, string> {
    const titles = new Map<string, string>();
    for (const action of actions)
      if (action.kind === "add_child" && action.ref) titles.set(`${MAP_CHAT_NEW_PREFIX}${action.ref}`, action.title);
    return titles;
  }
  private chatActionLabel(action: MapChatAction, refTitles?: ReadonlyMap<string, string>): string {
    const nodes = this.map?.nodes ?? [];
    const title = (id: string): string =>
      refTitles?.get(id) ?? this.notes.get(id)?.title ?? nodes.find(node => node.id === id)?.path ?? id;
    const targets = (ids: string[]): number => (ids.length ? ids.length : this.chatSelectionIds().length);
    switch (action.kind) {
      case "add_child":
        return t("ui.map_chat_do_add_child_0", action.title);
      case "rename_topic":
        return t("ui.map_chat_do_rename_0", action.title);
      case "update_summary":
        return t("ui.map_chat_do_summary_0", title(action.nodeId));
      case "edit_topic_note":
        return t("ui.map_chat_do_note_0", title(action.nodeId));
      case "move_topic":
        return t("ui.map_chat_do_move_0_1", title(action.nodeId), title(action.newParentId));
      case "delete_topic":
        return t("ui.map_chat_do_delete_0", title(action.nodeId));
      case "edit_md_file":
        return t("ui.map_chat_do_edit_md_0", action.path);
      case "create_md_file":
        return t("ui.map_chat_do_create_md_0", action.path);
      case "select_topics":
        return t("ui.map_chat_do_select_0", action.all ? nodes.length : action.nodeIds.length);
      case "create_map":
        return t("ui.map_chat_do_create_map_0", action.title);
      case "open_map":
        return t("ui.map_chat_do_open_map_0", action.title);
      case "collapse_topic":
        return t("ui.map_chat_do_collapse_0", title(action.nodeId));
      case "expand_topic":
        return t("ui.map_chat_do_expand_topic_0", title(action.nodeId));
      case "auto_layout":
        return t("ui.map_chat_do_auto_layout");
      case "focus_topic":
        return t("ui.map_chat_do_focus_0", title(action.nodeId));
      case "run_map_action":
        switch (action.action) {
          case "research_standard":
            return (
              t(
                chatResearchMode(action, this.map?.aiMode) === "quick"
                  ? "ui.map_chat_do_research_quick"
                  : "ui.map_chat_do_research_standard"
              ) + this.chatModelSuffix(this.chatTargetModels(action.nodeIds))
            );
          case "expand":
            return (
              t("ui.map_chat_do_expand_0", targets(action.nodeIds)) +
              this.chatModelSuffix(this.chatTargetModels(action.nodeIds))
            );
          case "synthesize": {
            const ids = action.nodeIds.length ? action.nodeIds : this.chatSelectionIds();
            const models = this.chatTargetModels(ids);
            return (
              t("ui.map_chat_do_synthesize") +
              // Several cards run on the one shared override, else the current model (see selectionModel).
              this.chatModelSuffix(ids.length > 1 && models.length > 1 ? [this.currentModelId()] : models)
            );
          }
          case "rate_by_goal":
            return t("ui.map_chat_do_rate_0", action.goal) + this.chatModelSuffix([this.currentModelId()]);
          case "merge":
            return t("ui.map_chat_do_merge_0", action.title);
          case "find_images": {
            const ids = action.nodeIds.length ? action.nodeIds : this.chatSelectionIds();
            return (
              t("ui.map_chat_do_find_images_0", ids.length === 1 ? title(ids[0]) : action.direction || "…") +
              this.chatModelSuffix(this.chatTargetModels(ids))
            );
          }
        }
    }
  }
  private currentModelId(): string {
    return this.plugin.settings.cliModel?.trim() || FALLBACK_MODEL;
  }
  /** The models the named cards (else the selection) run on, each once, from the cards the view already holds. */
  private chatTargetModels(ids: string[]): string[] {
    const list = ids.length ? ids : this.chatSelectionIds();
    const models = list.map(id => this.notes.get(id)?.model || this.currentModelId());
    return [...new Set(models.length ? models : [this.currentModelId()])];
  }
  /** "（label）" after a result row: the model(s) the task really runs on. */
  private chatModelSuffix(models: string[]): string {
    return t(
      "ui.map_chat_model_suffix_0",
      models.map(model => this.plugin.modelLabel(model)).join(t("ui.map_chat_model_separator"))
    );
  }
  private chatLine(label: string, outcome: ChatOutcome): MapChatLine {
    // A picture search that has only started says so; its line follows the candidate block from then on (settledLine).
    if (outcome.status === "done" && outcome.images)
      return {
        status: "done",
        text:
          t("ui.map_chat_line_images_started_0", outcome.images.nodeTitle) +
          (outcome.images.modelLabel ? t("ui.map_chat_model_suffix_0", outcome.images.modelLabel) : ""),
        images: outcome.images
      };
    if (outcome.status === "done") return { status: "done", text: t("ui.map_chat_line_done_0", label) };
    return {
      status: outcome.status,
      text: t(
        outcome.status === "skipped" ? "ui.map_chat_line_skipped_0_1" : "ui.map_chat_line_failed_0_1",
        label,
        outcome.reason
      )
    };
  }
  /**
   * Holds back every repaint of this view and every re-read of the plugin's views while a long reply is applied: each write
   * would otherwise repaint twice and re-read the whole map, which costs seconds for a hundred cards. {@link releaseChatBatch}
   * lets them happen once.
   */
  private holdChatBatch(): void {
    if (this.heldViews.length) return;
    this.heldViews = [this, ...this.plugin.views().filter(view => view !== this)];
    this.renderHold++;
    for (const view of this.heldViews) view.syncHold++;
  }
  private async releaseChatBatch(): Promise<void> {
    const held = this.heldViews;
    if (!held.length) return;
    this.heldViews = [];
    this.renderHold = Math.max(0, this.renderHold - 1);
    for (const view of held) view.syncHold = Math.max(0, view.syncHold - 1);
    if (this.renderHold === 0 && this.renderPending) {
      this.renderPending = false;
      this.render();
    }
    if (!held.some(view => view.syncPending)) return;
    for (const view of held) view.syncPending = false;
    try {
      // An empty write: its tail re-reads every view once.
      await this.plugin.mutate(async () => {});
    } catch {
      // mutate() has logged it; the views catch up at their next write.
    }
  }
  /** Rebuilds the derived data once for the cards a reply added, then lets the held repaint and re-read happen. */
  private async settleChatBatch(run: ChatRun): Promise<void> {
    if (run.ownershipDirty) {
      run.ownershipDirty = false;
      try {
        // plugin.rebuildDerivedData reports its own failure; the queue only keeps it from running between two writes.
        await this.plugin.mutate(async () => {
          await this.plugin.rebuildDerivedData();
        });
      } catch {
        // mutate() has logged it.
      }
    }
    await this.releaseChatBatch();
  }
  /** A repaint a batch is holding back happens now, for the step that needs the cards measured (layout). */
  private flushChatRender(): void {
    if (!this.renderPending || this.closed) return;
    this.renderPending = false;
    this.paint();
  }
  /**
   * Applies what a chat reply asked for, once, in order. Every write is its own `plugin.mutate` (the queue cannot be
   * re-entered, and the task a run action starts uses it too), checked again for staleness inside it and, for Markdown
   * files, by the write guard. None of it leaves an undo step. A stale or refused action is skipped; the rest go on.
   * Selecting cards, the run actions and `open_map` come after every write, outside any mutate. Resolves with one line per action.
   *
   * `new:<ref>` ids are swapped for the real card ids as the cards are created; a card whose parent was not created is skipped.
   * `create_map` (always first) opens a new map and the rest of the reply builds in it; if it fails nothing else is written.
   * `anchor` is the map this reply belongs to; a create or open the reply performs moves it, so the rest of the reply and the
   * caller's liveness check follow the conversation to the new map. A reply that adds five cards or more is followed by one
   * automatic layout and a move of the view to the new cards.
   */
  async applyMapChatActions(
    result: Pick<MapChatResult, "actions" | "rejected"> & {
      /** The user's message; an integration in the reply takes it as its direction. */
      message?: string;
    },
    baseline: Pick<MapChatContext, "mdHashes" | "topicHashes">,
    alive: () => boolean = () => true,
    anchor: { path: string; id: string | undefined } = { path: this.path, id: this.map?.id }
  ): Promise<MapChatLine[]> {
    const touched = new Set<string>([anchor.path]);
    const same = (): boolean => !this.closed && alive() && this.path === anchor.path && this.map?.id === anchor.id;
    /** Why the rest is skipped: the user stopped it, or the map is not the one the reply was about. */
    const lost = (): ChatOutcome =>
      skipped(!this.closed && !alive() ? "ui.map_chat_skip_stopped" : "ui.map_chat_skip_map_changed");
    const lines: MapChatLine[] = [];
    const later: number[] = [];
    const run: ChatRun = { refs: new Map(), created: [] };
    // How many find_images this reply has asked for so far (the first MAP_CHAT_FIND_IMAGES_LIMIT start, the rest are skipped).
    const laterBatch = { imageSearches: 0 };
    // How many cards existed when the last auto_layout of the reply ran: the ones made after it are only roughly placed.
    let laidOutCount = 0;
    let layoutDone = false;
    // True once the reply stopped before its end (the user's Stop, or the view going away).
    let stopped = false;
    const refTitles = this.chatRefTitles(result.actions);
    let wrote = false;
    // True once a create_map failed: the rest would land in the map the user is looking at, which is not what was asked.
    let noNewMap = false;
    // ... and why: the map was never made, or it was made but could not be opened here.
    let noNewMapReason: TranslationKey = "ui.map_chat_skip_map_not_created";
    // Copied: the turn's own writes move the baseline along, the request's context stays as it was sent.
    const own = { mdHashes: baseline.mdHashes, topicHashes: { ...baseline.topicHashes } };
    // A reply that adds many cards is laid out as a whole afterwards, so its writes repaint once at the end. One that adds a
    // few cards places each against the cards painted so far, so it keeps repainting after every write.
    const adds = result.actions.filter(action => action.kind === "add_child").length;
    const batched = adds === 0 || adds >= MAP_CHAT_AUTO_LAYOUT_MIN_NEW;
    try {
      if (batched) this.holdChatBatch();
      run.deferRebuild = batched;
      for (const [index, action] of result.actions.entries()) {
        if (action.kind === "select_topics" || action.kind === "run_map_action" || action.kind === "open_map") {
          later.push(index);
          continue;
        }
        const label = this.chatActionLabel(action, refTitles);
        if (!same()) {
          stopped = true;
          lines[index] = this.chatLine(label, lost());
          continue;
        }
        if (noNewMap) {
          lines[index] = this.chatLine(label, skipped(noNewMapReason));
          continue;
        }
        if (action.kind === "create_map") {
          // The map switch repaints on its own.
          await this.settleChatBatch(run);
          const outcome = await this.chatCreateMap(action.title, anchor, same);
          if (batched) this.holdChatBatch();
          if (outcome.status === "done") {
            wrote = true;
            touched.add(anchor.path);
            // The old map's baseline means nothing in the new one.
            own.topicHashes = {};
          } else {
            noNewMap = true;
            if ("created" in outcome && outcome.created) noNewMapReason = "ui.map_chat_skip_map_not_opened";
          }
          lines[index] = this.chatLine(label, outcome);
          continue;
        }
        const box: { outcome: ChatOutcome } = { outcome: { status: "done" } };
        try {
          await this.plugin.mutate(async () => {
            box.outcome = await this.applyChatWrite(action, own, same, run);
          });
        } catch (error) {
          box.outcome = { status: "failed", reason: errorMessage(error) };
        }
        if (box.outcome.status !== "skipped" && action.kind !== "focus_topic") wrote = true;
        if (action.kind === "auto_layout" && box.outcome.status === "done") {
          laidOutCount = run.created.length;
          layoutDone = true;
        }
        lines[index] = this.chatLine(label, box.outcome);
      }
      // Many cards at once land in a rough spot: one layout for the lot, then the view goes to the new branch.
      let arranged = false;
      if (
        run.created.length >= MAP_CHAT_AUTO_LAYOUT_MIN_NEW &&
        !noNewMap &&
        same() &&
        !result.actions.some(action => action.kind === "auto_layout")
      ) {
        try {
          await this.plugin.mutate(async () => {
            if (!same() || !this.map) return;
            // The layout measures the cards, so the held repaint comes first.
            this.flushChatRender();
            await this.mapChange(map => {
              map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
            }, false);
            const nodes = this.map?.nodes ?? [];
            const fresh = run.created.map(id => nodes.find(node => node.id === id)).filter((n): n is MapNode => !!n);
            const target = fresh.find(node => !node.parentId) ?? fresh[0];
            // A card the reply asked to look at is where the view goes; this move to the new branch is only the default.
            if (target && !result.actions.some(action => action.kind === "focus_topic")) this.focusNode(target);
            arranged = true;
          });
        } catch {
          // The cards are written already; only the tidy-up failed, and the user can lay the map out by hand.
        }
      }
      if (arranged) lines.push({ status: "done", text: t("ui.map_chat_auto_layout_added") });
      // A stop that lands after the last action is a stop too.
      if (!same()) stopped = true;
      // A stop, or an auto_layout that came before the cards, leaves them at the rough spot of a held batch (unmeasured heights).
      // Only those cards are placed, each branch beside its parent; nothing else moves, and no other action of the reply runs.
      const rough = batched && !arranged && (stopped || layoutDone) ? run.created.slice(laidOutCount) : [];
      if (rough.length && !this.closed && this.path === anchor.path && this.map?.id === anchor.id) {
        try {
          await this.plugin.mutate(async () => {
            if (this.closed || this.path !== anchor.path || this.map?.id !== anchor.id) return;
            this.flushChatRender();
            await this.mapChange(map => {
              map.nodes = this.placeChatCards(map.nodes, new Set(rough));
            }, false);
          });
        } catch {
          // The cards are written already; only the tidy-up failed, and the user can lay the map out by hand.
        }
      }
    } finally {
      // The chat's own writes are not undoable (the owner's choice). Undo entries hold snapshots of the map from before
      // the write, so any entry that survived would put the map back out of step with the notes the chat wrote or moved.
      // Drop the history here and in every other view of the same map, like any other change made outside the view.
      if (wrote) {
        this.history.clear();
        for (const view of this.plugin.views()) if (view !== this && touched.has(view.path)) view.history.clear();
        this.updateHistoryButtons();
      }
      // Whatever ended the loop (done, stopped, closed, thrown), the derived data, the held repaint and the re-read happen once.
      await this.settleChatBatch(run);
    }
    for (const index of later) {
      const action = result.actions[index];
      const label = this.chatActionLabel(action, refTitles);
      let outcome: ChatOutcome;
      if (!same()) outcome = lost();
      else if (noNewMap) outcome = skipped(noNewMapReason);
      else {
        try {
          if (action.kind === "open_map") {
            outcome = await this.chatOpenMap(action.title, anchor, same);
            if (outcome.status === "done") touched.add(anchor.path);
          } else {
            const resolved = this.chatResolveTargets(
              action as Extract<MapChatAction, { kind: "select_topics" | "run_map_action" }>,
              run
            );
            outcome = resolved
              ? await this.runChatSelection(resolved.action, result.message ?? "", laterBatch)
              : skipped("ui.map_chat_skip_parent_missing");
          }
        } catch (error) {
          outcome = { status: "failed", reason: errorMessage(error) };
        }
      }
      lines[index] = this.chatLine(label, outcome);
    }
    const all = [...lines];
    if (result.rejected.length)
      all.push({ status: "skipped", text: t("ui.map_chat_rejected_0", result.rejected.length) });
    if (wrote) all.push({ status: "done", text: t("ui.map_chat_not_undoable") });
    return all;
  }
  /** Places the cards a reply made (and only those): each new branch beside its parent, a new tree below the others. */
  private placeChatCards(nodes: MapNode[], fresh: Set<string>): MapNode[] {
    const subtree = (rootId: string): Set<string> => {
      const ids = new Set([rootId]);
      for (let grew = true; grew;) {
        grew = false;
        for (const node of nodes)
          if (fresh.has(node.id) && node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
            ids.add(node.id);
            grew = true;
          }
      }
      return ids;
    };
    let placed = nodes;
    const tops = nodes.filter(node => fresh.has(node.id) && !(node.parentId && fresh.has(node.parentId)));
    const done = new Set<string>();
    for (const top of tops) {
      if (done.has(top.id)) continue;
      if (!top.parentId) {
        const ids = subtree(top.id);
        placed = arrangeNewTree(placed, top.id, ids, this.cardHeightOf, layoutOf(this.map));
        for (const id of ids) done.add(id);
        continue;
      }
      // Every new card under the same parent is placed together.
      const siblings = tops.filter(other => other.parentId === top.parentId);
      const ids = new Set<string>();
      for (const sibling of siblings) for (const id of subtree(sibling.id)) ids.add(id);
      placed = arrangeNewBranch(placed, top.parentId, ids, this.cardHeightOf, undefined, layoutOf(this.map));
      for (const id of ids) done.add(id);
    }
    return placed;
  }
  /**
   * Swaps `new:<ref>` target ids for the cards they became; null when every target was a card that was never created.
   */
  private chatResolveTargets(
    action: Extract<MapChatAction, { kind: "select_topics" | "run_map_action" }>,
    run: ChatRun
  ): { action: Extract<MapChatAction, { kind: "select_topics" | "run_map_action" }> } | null {
    if (action.kind === "select_topics" && action.all) return { action };
    const ids = action.nodeIds
      .map(id => (id.startsWith(MAP_CHAT_NEW_PREFIX) ? run.refs.get(id.slice(MAP_CHAT_NEW_PREFIX.length)) : id))
      .filter((id): id is string => !!id);
    // A target list that lost all its entries must not turn into "the current selection".
    if (action.nodeIds.length && !ids.length) return null;
    return { action: { ...action, nodeIds: ids } };
  }
  /** create_map: makes the map, opens it (the conversation goes along) and moves the anchor to it. */
  private async chatCreateMap(
    title: string,
    anchor: { path: string; id: string | undefined },
    same: () => boolean
  ): Promise<ChatOutcome> {
    const name = sanitizeGeneratedTitle(title).trim();
    if (!name) return skipped("ui.map_chat_skip_unavailable");
    let opened = "";
    const made = { created: false };
    try {
      await this.plugin.mutate(async () => {
        if (!same()) return;
        const mapPath = await this.plugin.repo.createMap(name);
        made.created = true;
        opened = await this.chatSwitchTo(mapPath, anchor);
      });
    } catch (error) {
      return { status: "failed", reason: errorMessage(error), created: made.created };
    }
    if (opened) return { status: "done" };
    // A map that was made but is not open is not "the map was changed": say what happened.
    return made.created
      ? { status: "skipped", reason: t("ui.map_chat_skip_map_not_opened"), created: true }
      : skipped("ui.map_chat_skip_map_changed");
  }
  /** open_map: the view names the map, not the model. One match opens it; several are listed to pick from; none is a skip. */
  private async chatOpenMap(
    title: string,
    anchor: { path: string; id: string | undefined },
    same: () => boolean
  ): Promise<ChatOutcome> {
    const topics = await this.plugin.repo.topics();
    const match = matchMapTitle(title, topics);
    if (match.kind === "none") return skipped("ui.map_chat_skip_map_not_found");
    if (match.kind === "many") {
      const parts = mapChoiceParts(match.maps);
      this.chat?.showChoices({
        prompt: t("ui.map_chat_choose_map"),
        options: match.maps.map((topic, index) => {
          const part = parts[index];
          const label = part.seq
            ? t("ui.map_chat_choose_label_0_1_2", part.title, part.folder ?? "", part.seq)
            : part.folder
              ? t("ui.map_chat_choose_label_0_1", part.title, part.folder)
              : part.title;
          return { label, pick: () => void this.chatPickMap(topic) };
        }),
        picked: false
      });
      return skipped("ui.map_chat_skip_map_choose");
    }
    let opened = "";
    await this.plugin.mutate(async () => {
      if (!same()) return;
      opened = await this.chatSwitchTo(match.map.mapPath, anchor);
    });
    return opened ? { status: "done" } : skipped("ui.map_chat_skip_map_changed");
  }
  /** The user picked one of several maps the reply named. */
  private async chatPickMap(topic: { title: string; mapPath: string }): Promise<void> {
    const chat = this.chat;
    if (!chat || this.closed || chat.isBusy || this.chatApplying) return;
    this.chatApplying = true;
    try {
      let opened = "";
      await this.plugin.mutate(async () => {
        if (!this.closed) opened = await this.chatSwitchTo(topic.mapPath, { path: this.path, id: this.map?.id });
      });
      this.chat?.appendLines([
        opened
          ? { status: "done", text: t("ui.map_chat_choose_opened_0", topic.title) }
          : { status: "skipped", text: t("ui.map_chat_skip_map_changed") }
      ]);
    } catch (error) {
      this.chat?.appendLines([{ status: "failed", text: errorMessage(error) }]);
    } finally {
      this.chatApplying = false;
    }
  }
  /**
   * Opens a map for the conversation (inside a mutate) and moves `anchor`, the map the turn belongs to, along with it; returns
   * the path, or "" when the map did not end up open. The anchor moves even when the open fails late, once the view is on it.
   */
  private async chatSwitchTo(mapPath: string, anchor: { path: string; id: string | undefined }): Promise<string> {
    this.chatCarryOver = true;
    try {
      await this.openMapInMutation(mapPath);
    } finally {
      this.chatCarryOver = false;
      if (!this.closed && this.path === mapPath && this.map) {
        anchor.path = mapPath;
        anchor.id = this.map.id;
        this.chatMapId = this.map.id;
      }
    }
    return !this.closed && this.path === mapPath && this.map ? mapPath : "";
  }
  /** One write action. Runs inside `plugin.mutate`: it must not queue another one. */
  private async applyChatWrite(
    action: Exclude<MapChatAction, { kind: "select_topics" | "run_map_action" | "create_map" | "open_map" }>,
    baseline: Pick<MapChatContext, "mdHashes" | "topicHashes">,
    same: () => boolean,
    run: ChatRun = { refs: new Map(), created: [] }
  ): Promise<ChatOutcome> {
    const hashes = baseline.mdHashes;
    if (!same() || !this.map) return skipped("ui.map_chat_skip_map_changed");
    const nodeOf = (id: string): MapNode | undefined => this.map?.nodes.find(item => item.id === id);
    const gone = skipped("ui.map_chat_skip_topic_gone");
    const done: ChatOutcome = { status: "done" };
    const configDir = this.app.vault.configDir;
    /** The real id behind an id of the reply; null when it names a card of this reply that was never created. */
    const real = (id: string): string | null =>
      id.startsWith(MAP_CHAT_NEW_PREFIX) ? (run.refs.get(id.slice(MAP_CHAT_NEW_PREFIX.length)) ?? null) : id;
    switch (action.kind) {
      case "add_child": {
        // An empty parent is a new root card.
        let parent: MapNode | null = null;
        if (action.parentId) {
          const parentId = real(action.parentId);
          if (parentId === null) return skipped("ui.map_chat_skip_parent_missing");
          parent = nodeOf(parentId) ?? null;
          if (!parent) return gone;
          if (this.isMerging(parent.id)) return skipped("ui.map_chat_skip_merge_locked");
        }
        const before = new Set(this.map.nodes.map(item => item.id));
        // The derived data (every map is read for it) is rebuilt once, when the reply ends, not after each card; marked first so
        // a card that was written before the action failed is covered too.
        if (run.deferRebuild) run.ownershipDirty = true;
        await this.addNode(parent, action.title, !run.deferRebuild, false);
        const created = this.map?.nodes.find(item => !before.has(item.id));
        if (!created) return skipped("ui.map_chat_skip_unavailable");
        run.created.push(created.id);
        if (action.ref) run.refs.set(action.ref, created.id);
        if (action.summary) await this.noteChange(created, { summary: action.summary });
        return done;
      }
      case "collapse_topic":
      case "expand_topic": {
        this.flushChatRender();
        const id = real(action.nodeId);
        if (id === null) return skipped("ui.map_chat_skip_parent_missing");
        const node = nodeOf(id);
        if (!node) return gone;
        if (!this.map.nodes.some(item => item.parentId === node.id)) return skipped("ui.map_chat_skip_no_children");
        const collapsed = action.kind === "collapse_topic";
        await this.mapChange(map => {
          const target = map.nodes.find(item => item.id === node.id);
          if (target) target.collapsed = collapsed;
          map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
        });
        return done;
      }
      case "auto_layout":
        // The layout measures the cards, so a held repaint comes first.
        this.flushChatRender();
        await this.mapChange(map => {
          map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
        }, false);
        return done;
      case "focus_topic": {
        this.flushChatRender();
        const id = real(action.nodeId);
        if (id === null) return skipped("ui.map_chat_skip_parent_missing");
        const node = nodeOf(id);
        if (!node) return gone;
        this.focusNode(node);
        return done;
      }
      case "rename_topic":
      case "update_summary":
      case "edit_topic_note": {
        const node = nodeOf(action.nodeId);
        if (!node) return gone;
        if (this.isMerging(node.id)) return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes, action.kind === "edit_topic_note");
        if (changed) return changed;
        await this.noteChange(
          node,
          action.kind === "rename_topic"
            ? { title: action.title }
            : action.kind === "update_summary"
              ? { summary: action.summary }
              : { detail: action.detail }
        );
        await this.chatTopicAccept(node.id, baseline.topicHashes);
        return done;
      }
      case "move_topic": {
        const node = nodeOf(action.nodeId);
        const parentId = real(action.newParentId);
        if (parentId === null) return skipped("ui.map_chat_skip_parent_missing");
        const parent = nodeOf(parentId);
        if (!node || !parent) return gone;
        if (this.isMerging(node.id) || this.isMerging(parent.id)) return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes);
        if (changed) return changed;
        if (!canParent(this.map.nodes, node.id, parent.id)) return skipped("ui.map_chat_skip_cycle");
        await this.moveTopic(node, parent);
        await this.chatTopicAccept(node.id, baseline.topicHashes);
        return done;
      }
      case "delete_topic": {
        const node = nodeOf(action.nodeId);
        if (!node) return gone;
        if (this.isMerging(node.id)) return skipped("ui.map_chat_skip_merge_locked");
        const changed = await this.chatTopicStale(node.id, baseline.topicHashes);
        if (changed) return changed;
        await this.removeToUnassigned(node, action.branch);
        return done;
      }
      case "edit_md_file": {
        // Path rules first, so a refused place is named as such rather than as a missing or stale file.
        const early = guardMapChatWrite({
          kind: "edit",
          path: action.path,
          newContent: "",
          knownHashes: hashes,
          configDir
        });
        if (!early.ok) return guardSkipped(early.code);
        const source = await this.readChatFile(action.path);
        if (!source) return skipped("ui.map_chat_skip_file_missing");
        if (isMdStale(hashes, action.path, source.text)) return skipped("ui.map_chat_skip_stale");
        const next = applyMdEdit(source.text, action.find, action.replace);
        if (next === null) return skipped("ui.map_chat_skip_find_failed");
        const verdict = guardMapChatWrite({
          kind: "edit",
          path: action.path,
          oldContent: source.text,
          newContent: next,
          knownHashes: hashes,
          configDir
        });
        if (!verdict.ok) return guardSkipped(verdict.code, true);
        if (source.editor) {
          const at = source.text.indexOf(action.find);
          source.editor.replaceRange(
            action.replace,
            source.editor.offsetToPos(at),
            source.editor.offsetToPos(at + action.find.length)
          );
          return done;
        }
        let raced = false;
        await this.app.vault.process(source.file, current => {
          // The file moved on between the check and the write: leave it as it is.
          if (current !== source.text) {
            raced = true;
            return current;
          }
          return next;
        });
        return raced ? skipped("ui.map_chat_skip_stale") : done;
      }
      case "create_md_file": {
        const key = normalizeVaultPath(action.path);
        const exists = key ? !!this.app.vault.getAbstractFileByPath(key) : false;
        const verdict = guardMapChatWrite({
          kind: "create",
          path: action.path,
          newContent: action.content,
          exists,
          configDir
        });
        if (!verdict.ok || !key) return guardSkipped(verdict.ok ? "outside_vault" : verdict.code);
        const folders = key.split("/").slice(0, -1);
        for (let depth = 1; depth <= folders.length; depth++) {
          const folder = folders.slice(0, depth).join("/");
          if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
        }
        await this.app.vault.create(key, action.content);
        return done;
      }
    }
  }
  private chatSelect(ids: string[]): void {
    this.multiSelected = new Set(ids);
    this.selected = null;
    this.integrationMode = true;
    if (!this.closed) this.render();
  }
  /** Selecting cards, and the run actions that start the map's own tasks; both after every write, outside a mutate. */
  private async runChatSelection(
    action: Extract<MapChatAction, { kind: "select_topics" | "run_map_action" }>,
    /** The user's message: the direction of an integration. */
    message = "",
    /** What the later actions of this reply have started so far. */
    batch: { imageSearches: number } = { imageSearches: 0 }
  ): Promise<ChatOutcome> {
    const map = this.map;
    if (!map) return skipped("ui.map_chat_skip_map_changed");
    const launch = (work: unknown): void => {
      void Promise.resolve(work).catch(error => new Notice(errorMessage(error)));
    };
    const known = (ids: string[]): string[] => ids.filter(id => this.map?.nodes.some(node => node.id === id));
    if (action.kind === "select_topics") {
      if (!this.canSelectTopics()) return skipped("ui.map_chat_skip_unavailable");
      const ids = action.all ? map.nodes.map(node => node.id) : known(action.nodeIds);
      if (!ids.length) return skipped("ui.map_chat_skip_topic_gone");
      this.chatSelect(ids);
      return { status: "done" };
    }
    if (!this.canSelectTopics()) return skipped("ui.map_chat_skip_unavailable");
    const targets = known(action.nodeIds);
    if (action.nodeIds.length && !targets.length) return skipped("ui.map_chat_skip_topic_gone");
    switch (action.action) {
      case "research_standard": {
        if (targets.length) this.chatSelect(targets);
        if (!this.multiSelected.size) return skipped("ui.map_chat_skip_unavailable");
        // A batch already running is told in the result, not only by the Notice the research itself shows.
        if (this.plugin.expansionCoordinator.isRunning(this.multiResearchKey()))
          return skipped("ui.map_chat_skip_research_running");
        // The search count comes when the batch ends, long after this turn: it joins this answer's lines if no newer turn began.
        const chat = this.chat;
        const turns = chat?.transcript().length ?? 0;
        // otherProvider counts only when every target offers the same other-provider model; otherwise it is ignored (D15).
        const retryModel = action.otherProvider
          ? this.otherProviderTarget(
              [...this.multiSelected].flatMap(id => this.map?.nodes.filter(node => node.id === id) ?? [])
            )
          : null;
        launch(
          this.startMultiResearch(
            {
              ...chatResearchRequest(action, this.map?.aiMode, mode => aiModeOptions(mode, "research")),
              ...(retryModel ? { model: retryModel } : {})
            },
            undefined,
            web => {
              const lines = researchWebLines(web);
              if (lines.length && chat && this.chat === chat && !this.closed && chat.transcript().length === turns)
                chat.appendLines(lines);
            }
          )
        );
        return { status: "done" };
      }
      case "expand": {
        const ids = targets.length ? targets : this.chatSelectionIds();
        const parents = known(ids)
          .map(id => this.map?.nodes.find(node => node.id === id))
          .filter((node): node is MapNode => !!node);
        if (!parents.length) return skipped("ui.map_chat_skip_unavailable");
        // The chat request is the confirmation of the changes, not of the AI call: each parent asks for its own model's
        // usage notice first, like the expand button. The subtopics are then added without the review window.
        for (const parent of parents)
          launch(
            this.plugin.repo
              .readNote(parent.path, this.map ?? undefined)
              .then(note => this.plugin.confirmAiUsage(note.model, () => this.chatExpand(parent, action.direction)))
          );
        return { status: "done" };
      }
      case "synthesize":
        return this.chatSynthesize(targets.length ? targets : this.chatSelectionIds(), message);
      case "rate_by_goal": {
        const goal = action.goal.trim();
        if (!goal || !this.relevanceGradeable()) return skipped("ui.map_chat_skip_unavailable");
        launch(this.submitRelevanceGoal(goal));
        return { status: "done" };
      }
      case "merge": {
        if (targets.length) this.chatSelect(targets);
        const title = action.title.trim();
        if (!title) return skipped("ui.map_chat_skip_unavailable");
        if (this.mergeTasks.has(this.path)) return skipped("ui.map_chat_skip_merge_locked");
        const check = this.mergeCheck();
        if (!check.ok) return skipped("ui.map_chat_skip_unavailable");
        const snapshot = {
          path: this.path,
          mapId: map.id,
          parentId: check.parentId,
          targetId: check.targetId,
          sources: check.sources.map(source => ({ id: source.id, path: source.path }))
        };
        await this.plugin.mutate(() => this.mergeSelected(title, snapshot));
        return { status: "done" };
      }
      case "find_images":
        return this.chatFindImages(action.direction, targets, batch);
    }
  }
  /**
   * find_images: the chat only picked the card and the search words. The search itself is the Markdown quick action's: the
   * `markdown.image-search` step through the card's own model (after its usage notice), then only the candidates whose thumbnail
   * loads. The outcome is "done" once the search started; its candidates join the reply's row later, and nothing is written to
   * any note until the user picks one (see {@link chatInsertImage}).
   */
  private async chatFindImages(
    direction: string,
    targets: string[],
    batch: { imageSearches: number }
  ): Promise<ChatOutcome> {
    batch.imageSearches += 1;
    if (batch.imageSearches > MAP_CHAT_FIND_IMAGES_LIMIT)
      return { status: "skipped", reason: t("ui.map_chat_skip_images_limit_0", MAP_CHAT_FIND_IMAGES_LIMIT) };
    const map = this.map;
    const chat = this.chat;
    if (!map || !chat) return skipped("ui.map_chat_skip_map_changed");
    const ids = targets.length ? targets : this.chatSelectionIds();
    if (ids.length !== 1) return skipped("ui.map_chat_skip_images_one_card");
    const node = map.nodes.find(item => item.id === ids[0]);
    if (!node) return skipped("ui.map_chat_skip_topic_gone");
    const note = await this.plugin.repo.readNote(node.path, map);
    const query = direction.trim() || note.title.trim();
    if (!query) return skipped("ui.map_chat_skip_unavailable");
    const anchor = { path: this.path, id: map.id };
    return new Promise<ChatOutcome>(resolve => {
      let settled = false;
      const settle = (outcome: ChatOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      void this.plugin
        .confirmAiUsage(note.model, async () => {
          if (this.closed || this.chat !== chat || this.path !== anchor.path || this.map?.id !== anchor.id) {
            settle(skipped("ui.map_chat_skip_map_changed"));
            return;
          }
          const controller = new AbortController();
          const key = ++this.chatImageSequence;
          this.chatImageSearches.set(key, controller);
          const block: MapChatImages = {
            query,
            nodeId: node.id,
            nodeTitle: note.title,
            modelLabel: this.plugin.modelLabel(note.model),
            mapPath: anchor.path,
            mapId: anchor.id,
            state: "searching",
            items: [],
            stop: () => {
              if (this.chatImageSearches.get(key) !== controller) return;
              this.chatImageSearches.delete(key);
              controller.abort();
              chat.settleImages(block, { state: "stopped" });
            }
          };
          chat.addImages(block);
          settle({ status: "done", images: block });
          try {
            await this.runImageSearch(block, controller, chat, note.model);
          } finally {
            if (this.chatImageSearches.get(key) === controller) this.chatImageSearches.delete(key);
          }
        })
        .then(
          () => settle(skipped("ui.map_chat_skip_not_started")),
          error => settle({ status: "failed", reason: errorMessage(error) })
        );
    });
  }
  /** The thumbnail check of a search (a seam: it loads images, which only a real page can). */
  private chatProbeImages(found: ImageCandidate[], signal: AbortSignal): Promise<ImageCandidate[]> {
    return loadableImages(found, signal);
  }
  /** Runs one picture search to its end and shows what came of it, unless the view, the panel or the map is not the same any more. */
  private async runImageSearch(
    block: MapChatImages,
    controller: AbortController,
    chat: MapChatPanel,
    model: string
  ): Promise<void> {
    const sameMap = (): boolean => this.path === block.mapPath && this.map?.id === block.mapId;
    /** Still the place the search was started for: shown only then. */
    const current = (): boolean => !this.closed && !controller.signal.aborted && this.chat === chat && sameMap();
    /** The conversation moved on to another map (or a stop was not the cause): say it, but only when the panel is still here. */
    const dropped = (): void => {
      if (this.closed || controller.signal.aborted || this.chat !== chat) return;
      chat.settleImages(block, { state: "failed", reason: t("ui.map_chat_images_stale_map") });
    };
    try {
      const found = await this.plugin.searchImages(block.query, model, controller.signal);
      if (!current()) return dropped();
      // Web results can be stale or block hotlinking: offer only images that actually load.
      const loadable = (await this.chatProbeImages(found, controller.signal)).slice(0, 6);
      if (!current()) return dropped();
      if (!loadable.length) chat.settleImages(block, { state: "empty" });
      else chat.settleImages(block, { state: "ready", items: loadable.map(candidate => ({ candidate })) });
    } catch (error) {
      if (!current()) return dropped();
      chat.settleImages(block, { state: "failed", reason: errorMessage(error) });
    }
  }
  /**
   * The user picked a picture candidate: it goes to the end of the card's Detail (a blank line before it), as one undoable edit.
   * Refused, with the reason in words and nothing written, when the map in view is not the one the candidate came from, the card
   * is gone, being merged or being worked on by an AI task, or the map cannot be edited. The same checks run again inside the
   * write, where nothing else can change the map.
   */
  private async chatInsertImage(block: MapChatImages, item: MapChatImageItem): Promise<MapChatInsertResult> {
    const fence = (): { reason: TranslationKey } | { node: MapNode } => {
      if (this.closed || !this.map || this.path !== block.mapPath || this.map.id !== block.mapId)
        return { reason: "ui.map_chat_images_stale_map" };
      if (this.builtIn || this.map.aim) return { reason: "ui.map_chat_images_stale_locked" };
      const node = this.map.nodes.find(candidate => candidate.id === block.nodeId);
      if (!node) return { reason: "ui.map_chat_images_stale_gone" };
      if (this.isMerging(node.id)) return { reason: "ui.map_chat_images_stale_merging" };
      if (this.plugin.running?.has(node.path) || this.plugin.activeTasks?.has(node.path))
        return { reason: "ui.map_chat_images_stale_running" };
      return { node };
    };
    const first = fence();
    if ("reason" in first) return { ok: false, reason: t(first.reason) };
    const outcome: { result: MapChatInsertResult } = {
      result: { ok: false, reason: t("ui.map_chat_images_stale_map") }
    };
    try {
      await this.plugin.mutate(async () => {
        const again = fence();
        if ("reason" in again) {
          outcome.result = { ok: false, reason: t(again.reason) };
          return;
        }
        // A failure is carried out as a result, not thrown: mutate() would show its own Notice for a throw, and this is the second.
        try {
          const note = await this.plugin.repo.readNote(again.node.path, this.map ?? undefined);
          const before = note.detail.replace(/\s+$/, "");
          const addition = imageMarkdown(item.candidate);
          await this.noteChange(again.node, { detail: before ? `${before}\n\n${addition}` : addition });
          outcome.result = { ok: true };
        } catch (error) {
          outcome.result = { ok: false, reason: t("ui.map_chat_images_insert_failed_0", errorMessage(error)) };
        }
      });
    } catch (error) {
      return { ok: false, reason: t("ui.map_chat_images_insert_failed_0", errorMessage(error)) };
    }
    return outcome.result;
  }
  /** What the chat window gets of a saved turn: the vault paths of the cards and notes it named, and the picture candidates. */
  private chatTranscriptTurn(turn: MapChatSavedTurn): TranscriptTurn {
    const { question, answer } = turn;
    const refs: TranscriptRef[] = [];
    const seen = new Set<string>();
    const topic = (id: string): void => {
      if (seen.has(id)) return;
      seen.add(id);
      const node = this.map?.nodes.find(item => item.id === id);
      if (node) refs.push({ kind: "topic", path: node.path, title: this.notes.get(id)?.title ?? node.path });
    };
    for (const chip of question.origin?.chips ?? []) {
      if (chip.kind === "topic") topic(chip.id);
      else if (chip.kind === "file") refs.push({ kind: "file", path: chip.path, title: "" });
      else refs.push({ kind: "snippet", path: chip.path, title: "", text: chip.text });
    }
    for (const id of question.origin?.selectedIds ?? []) topic(id);
    return {
      question: question.text,
      refs,
      answer: answer.text,
      lines: answer.lines.map(line => settledLine(line).text),
      ...(answer.plan ? { plan: answer.plan.state } : {}),
      images: (answer.images ?? []).map(block => ({
        nodeTitle: block.nodeTitle,
        query: block.query,
        state: block.state,
        ...(block.reason ? { reason: block.reason } : {}),
        items: block.items.map(entry => ({
          title: entry.candidate.title,
          source: entry.candidate.source,
          ...(entry.inserted ? { inserted: entry.inserted } : {})
        }))
      }))
    };
  }
  /**
   * "Save as a note": writes the finished turns to `<map folder>/Chats/<date> <first sentence>.md`, a new file every time
   * (the repository's unique name adds " 2", " 3"; `vault.create` never overwrites). The folder is the one of the map in view
   * when the button is pressed. The note is built by {@link transcriptMarkdown} from a whitelist, never from the raw text.
   */
  private async saveChatTranscript(
    turns: MapChatSavedTurn[]
  ): Promise<{ ok: true; path: string } | { ok: false; reason: string }> {
    const map = this.map;
    if (this.closed || !map || this.builtIn || !turns.length)
      return { ok: false, reason: t("ui.map_chat_save_unavailable") };
    const mapPath = this.path;
    const savedAt = new Date();
    const first = turns[0].question;
    const name = chatNoteName(first.origin?.text ?? first.text, savedAt, t("ui.map_chat_save_default_name"));
    const markdown = transcriptMarkdown({
      mapTitle: map.title,
      mapPath,
      savedAt,
      labels: {
        title: t("ui.map_chat_note_title"),
        map: t("ui.map_chat_note_map"),
        saved: t("ui.map_chat_note_saved"),
        you: t("ui.map_chat_role_you"),
        ai: t("ui.map_chat_role_ai"),
        references: t("ui.map_chat_note_references"),
        results: t("ui.map_chat_note_results"),
        planPending: t("ui.map_chat_note_plan_pending"),
        planApplied: t("ui.map_chat_note_plan_applied"),
        planCancelled: t("ui.map_chat_note_plan_cancelled"),
        images: t("ui.map_chat_note_images_0", "{0}"),
        imagesSearching: t("ui.map_chat_note_images_searching_0", "{0}"),
        imagesNone: t("ui.map_chat_note_images_none"),
        imagesFailed: t("ui.map_chat_note_images_failed_0", "{0}"),
        imagesStopped: t("ui.map_chat_note_images_stopped"),
        inserted: t("ui.map_chat_note_inserted_0", "{0}")
      },
      turns: turns.map(turn => this.chatTranscriptTurn(turn))
    });
    const written: { path: string; error?: unknown } = { path: "" };
    try {
      await this.plugin.mutate(async () => {
        // A failure is carried out as a result, not thrown: mutate() would show its own Notice for a throw, and this is the second.
        try {
          const folder = `${this.plugin.repo.topicRoot(mapPath)}/Chats`;
          await this.plugin.repo.folder(folder);
          const path = this.plugin.repo.unique(folder, name);
          await this.app.vault.create(path, markdown);
          written.path = path;
        } catch (error) {
          written.error = error;
        }
      });
    } catch (error) {
      written.error = error;
    }
    if (written.error !== undefined) {
      const reason = t("ui.map_chat_save_failed_0", errorMessage(written.error));
      new Notice(reason);
      return { ok: false, reason };
    }
    new Notice(t("ui.map_chat_saved_0", written.path));
    return { ok: true, path: written.path };
  }
  /**
   * Expand from the chat: the multi-level outline expansion of the Next Step dialog (the same generator and the same writer),
   * with the map's default size (2 levels, at most 15 topics), every topic accepted and no review window. The new topics are
   * written without a research (`research-mode: local`, no task text). Like the dialog's run, the card shows running and Stop
   * while the outline is generated.
   */
  private async chatExpand(parent: MapNode, direction: string): Promise<void> {
    if (this.plugin.expansionCoordinator.isRunning(parent.path) || this.plugin.running.has(parent.path)) {
      new Notice(t("ui.ai_running_ai"));
      return;
    }
    const controller = new AbortController();
    this.plugin.running.add(parent.path);
    this.plugin.quickExpandPending.add(parent.path);
    this.plugin.activeTasks.set(parent.path, controller);
    this.render();
    try {
      const note = await this.plugin.repo.readNote(parent.path, this.map ?? undefined);
      const outline = this.quickOutline(parent);
      const limits = { levels: CHAT_EXPAND_LEVELS, maxTopics: CHAT_EXPAND_MAX_TOPICS };
      const generated = await outline.generate(
        {
          presetId: DEFAULT_OUTLINE_PRESET_ID,
          requirements: direction,
          language: defaultOutputLanguage(
            this.plugin.settings.language,
            note.title,
            existingNoteLanguage(note),
            this.outputLanguageMemory().outputLanguage
          ),
          limits
        },
        controller.signal
      );
      if (controller.signal.aborted || this.closed) return;
      const { nodes } = limitOutline(generated, limits);
      const items = outlineProposals(nodes);
      if (!items.length) {
        new Notice(t("ui.ai_does_not_recommend_decomposition_or_did_not_propose_3_to"));
        return;
      }
      // The parent may have been removed while the AI worked; the writer then refuses and says so.
      await outline.create(proposalOutline(items), {
        researchMode: "local",
        researchDepth: "normal",
        visualMode: "off",
        outputLanguage: defaultOutputLanguage(
          this.plugin.settings.language,
          note.title,
          existingNoteLanguage(note),
          this.outputLanguageMemory().outputLanguage
        )
      });
    } catch (error) {
      if (!controller.signal.aborted) new Notice(this.plugin.recordFailure(t("log.ai_split_failed"), error));
    } finally {
      if (this.plugin.activeTasks.get(parent.path) === controller) this.plugin.activeTasks.delete(parent.path);
      this.plugin.running.delete(parent.path);
      this.plugin.quickExpandPending.delete(parent.path);
      if (!this.closed) this.render();
    }
  }
  /**
   * Integration from the chat, without a dialog: the user's message is the direction and the draft step starts at once (the
   * suggested-directions step is skipped), with the options the dialog would have handed over unchanged. One card: its subtopics
   * are integrated into it (`startSynthesis`, written into that card). Two or more: they are integrated into a new topic, as
   * the selection integration does (`startSelectionSynthesis`). Resolves when the provider has accepted the request (started),
   * or the start failed or was skipped; what happens after that is the task's own (badge, status bar, Notice, undo notice).
   */
  private async chatSynthesize(ids: string[], message: string): Promise<ChatOutcome> {
    const map = this.map;
    if (!map) return skipped("ui.map_chat_skip_map_changed");
    const nodes = ids
      .filter((id, index) => ids.indexOf(id) === index)
      .map(id => map.nodes.find(node => node.id === id))
      .filter((node): node is MapNode => !!node);
    if (!nodes.length) return skipped("ui.map_chat_skip_unavailable");
    const settings = this.plugin.settings;
    const remembered = this.outputLanguageMemory().outputLanguage;
    if (nodes.length === 1) {
      const node = nodes[0];
      if (!map.nodes.some(item => item.parentId === node.id)) return skipped("ui.map_chat_skip_no_children");
      const task = this.synthesisTasks.get(node.path);
      if (
        this.plugin.running.has(node.path) ||
        this.plugin.activeTasks.has(node.path) ||
        task?.state === "running" ||
        task?.state === "directions"
      )
        return skipped("ui.map_chat_skip_synthesis_busy");
      const note = await this.plugin.repo.readNote(node.path, map);
      const options = chatSynthesisOptions({
        outputLanguage: defaultOutputLanguage(settings.language, note.title, existingNoteLanguage(note), remembered)
      });
      return this.launchChatTask(note.model, (failed, accepted) =>
        this.startSynthesis(node, options, message, failed, accepted)
      );
    }
    const waiting = this.integrationTask?.mapPath === this.path ? this.integrationTask : null;
    if (this.selectionStarting || (waiting && waiting.state !== "failed" && waiting.state !== "cancelled"))
      return skipped("ui.map_chat_skip_synthesis_busy");
    const names = nodes.map(node => this.notes.get(node.id)?.title ?? node.path);
    const options = chatSynthesisOptions({
      outputLanguage: defaultOutputLanguage(settings.language, "", undefined, remembered),
      synthesisTitle: synthesisDefaultName(resolveMapTextLanguage(map, settings.language), names)
    });
    // The run lives on the selection bar, so the sources are the selection while it runs.
    this.chatSelect(nodes.map(node => node.id));
    const chosen = await this.selectionModel(nodes);
    return this.launchChatTask(chosen.model, (failed, accepted) =>
      this.startSelectionSynthesis(nodes, options, message, failed, accepted)
    );
  }
  /**
   * Starts a task for the chat after its model's usage notice. The outcome is "done" once the provider accepted the request, and
   * "failed" when it said no before that (a failure after that is the task's own Notice); a declined notice is a skip.
   */
  private launchChatTask(
    model: string,
    start: (failed: (message: string) => void, accepted: () => void) => Promise<void>
  ): Promise<ChatOutcome> {
    return new Promise<ChatOutcome>(resolve => {
      let settled = false;
      const settle = (outcome: ChatOutcome): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      void this.plugin
        .confirmAiUsage(model, async () => {
          await start(
            message => {
              if (settled) new Notice(message);
              else settle({ status: "failed", reason: message });
            },
            () => settle({ status: "done" })
          );
        })
        .then(
          () => settle(skipped("ui.map_chat_skip_not_started")),
          error => settle({ status: "failed", reason: errorMessage(error) })
        );
    });
  }
  /** Topic selection (remove, move, copy, synthesize, merge) exists only on editable, non-AIM maps. */
  private canSelectTopics(): boolean {
    return !this.builtIn && !!this.map && !this.map.aim;
  }
  /** Starts topic selection with exactly the card's direct subtopics picked (replacing any earlier selection). */
  private selectSubtopics(node: MapNode): void {
    if (!this.map) return;
    const ids = this.map.nodes.filter(item => item.parentId === node.id).map(item => item.id);
    if (!ids.length) return;
    this.multiSelected = new Set(ids);
    this.selected = null;
    this.integrationMode = true;
    if (!this.closed) this.render();
  }
  /** True while a card drag is running on a map that is no longer the one shown here. */
  private dragStale(): boolean {
    const origin = this.dragOrigin;
    return !!origin && (!this.map || this.map.id !== origin.id || this.path !== origin.path);
  }
  /**
   * The width handle on a card's right edge, also an ARIA splitter. Dragging changes the width on screen and writes Map.md
   * once on release (one undo step); the arrow keys step by CARD_WIDTH_STEP, Home/End jump to the limits, Enter or a
   * double click goes back to the standard width (the field is removed).
   */
  private attachResizeHandle(card: HTMLElement, node: MapNode): void {
    const handle = card.createSpan({
      cls: "vam-card-resize",
      attr: {
        role: "separator",
        "aria-orientation": "vertical",
        "aria-label": t("ui.card_resize_label"),
        "aria-valuemin": String(CARD_WIDTH_MIN),
        "aria-valuemax": String(CARD_WIDTH_MAX)
      }
    });
    const widthOf = (): number => this.map?.nodes.find(item => item.id === node.id)?.width ?? CARD_WIDTH;
    const sync = (width: number): void => handle.setAttr("aria-valuenow", String(width));
    handle.tabIndex = -1;
    sync(widthOf());
    const commit = (width: number | undefined): void => {
      this.focusResizeNodeId = node.id;
      this.enqueue(() => this.resizeCard(node.id, width));
    };
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || !this.map) return;
      // The card's own pointerdown starts a move; the handle only resizes.
      event.stopPropagation();
      event.preventDefault();
      this.clearHoverTimer();
      this.hoverCard?.remove();
      this.hoverCard = null;
      const startX = event.clientX,
        zoom = this.map.viewport.zoom || 1,
        from = widthOf();
      let width = from,
        done = false;
      handle.setPointerCapture?.(event.pointerId);
      const move = (e: PointerEvent): void => {
        width = clampCardWidth(from + (e.clientX - startX) / zoom) ?? from;
        card.style.width = `${width}px`;
        sync(width);
      };
      const settle = (): void => {
        done = true;
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", cancel);
        handle.removeEventListener("lostpointercapture", cancel);
      };
      const restore = (): void => {
        if (from === CARD_WIDTH) card.style.removeProperty("width");
        else card.style.width = `${from}px`;
        sync(from);
      };
      const up = (): void => {
        if (done) return;
        settle();
        if (width === from) return restore();
        this.suppressClickUntil = Date.now() + 250;
        commit(width === CARD_WIDTH ? undefined : width);
      };
      const cancel = (): void => {
        if (done) return;
        settle();
        restore();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", cancel);
      handle.addEventListener("lostpointercapture", cancel);
    });
    handle.addEventListener("click", event => event.stopPropagation());
    handle.addEventListener("dblclick", event => {
      event.stopPropagation();
      event.preventDefault();
      if (widthOf() !== CARD_WIDTH) commit(undefined);
    });
    handle.addEventListener("keydown", event => {
      const current = widthOf();
      let next: number | undefined | null = null;
      if (event.key === "ArrowRight") next = current + CARD_WIDTH_STEP;
      else if (event.key === "ArrowLeft") next = current - CARD_WIDTH_STEP;
      else if (event.key === "Home") next = CARD_WIDTH_MIN;
      else if (event.key === "End") next = CARD_WIDTH_MAX;
      else if (event.key === "Enter") next = undefined;
      else return;
      event.preventDefault();
      event.stopPropagation();
      const width = next === undefined ? CARD_WIDTH : (clampCardWidth(next) ?? current);
      if (width === current) return;
      commit(width === CARD_WIDTH ? undefined : width);
    });
  }
  /** Sets (or, with undefined, clears) one card's custom width as one undo step. */
  private async resizeCard(id: string, width: number | undefined): Promise<void> {
    if (!this.map?.nodes.some(node => node.id === id)) return;
    await this.mapChange(map => {
      const node = map.nodes.find(item => item.id === id);
      if (!node) return;
      if (width === undefined || width === CARD_WIDTH) delete node.width;
      else node.width = clampCardWidth(width);
    }, false);
  }
  private enableDrag(card: HTMLElement, node: MapNode): void {
    card.addEventListener("pointerdown", event => {
      if ((event.target as Element).closest("button") || event.button !== 0 || !this.map) return;
      // In selection mode a card cannot be moved and a plain click still toggles it, but it can be dragged onto the chat.
      const selecting = this.integrationMode;
      this.clearHoverTimer();
      this.hoverCard?.remove();
      this.hoverCard = null;
      // A previous drag whose release never arrived must not leave its listeners behind.
      this.dragCleanup?.();
      const currentNode = this.map.nodes.find(item => item.id === node.id);
      if (!currentNode) return;
      this.dragging = true;
      this.dragOrigin = { id: this.map.id, path: this.path };
      const start = { x: event.clientX, y: event.clientY },
        origin = { x: currentNode.x, y: currentNode.y };
      let position = { ...origin },
        moved = false,
        travelled = false;
      // Dragging a picked card in selection mode moves every picked card together.
      const group = selecting && this.multiSelected.has(node.id) ? this.groupDragMembers(node, card) : null;
      const groupOrigins = new Map<string, { x: number; y: number }>();
      for (const id of group?.keys() ?? []) {
        const member = this.map.nodes.find(item => item.id === id);
        if (member) groupOrigins.set(id, { x: member.x, y: member.y });
      }
      let delta = { x: 0, y: 0 };
      // Sizes and the far end of each touching edge are read once; a move then only writes.
      const edges = group ? null : this.dragEdges(node.id, card);
      const groupEdges = group ? this.groupDragEdges(group) : null;
      const placeGroup = (dx: number, dy: number): void => {
        for (const [id, el] of group ?? []) {
          const from = groupOrigins.get(id);
          if (!from) continue;
          el.style.left = `${from.x + dx}px`;
          el.style.top = `${from.y + dy}px`;
        }
        groupEdges?.update(dx, dy);
      };
      card.setPointerCapture(event.pointerId);
      const paint = (): void => {
        this.dragFrame = null;
        if (group) {
          placeGroup(delta.x, delta.y);
          return;
        }
        card.style.left = `${position.x}px`;
        card.style.top = `${position.y}px`;
        edges?.update(position.x, position.y);
      };
      // A merging card stays where it is; the drop reports why.
      const locked = group ? [...group.keys()].some(id => this.isMerging(id)) : this.isMerging(node.id);
      // In a timeline a first-level topic is reordered, not placed, so a group holding one cannot move.
      const timelineBlocked =
        !!group &&
        !this.map.aim &&
        layoutOf(this.map).direction === "timeline" &&
        [...group.keys()].some(id => {
          const parentId = this.map?.nodes.find(item => item.id === id)?.parentId;
          const parent = parentId ? this.map?.nodes.find(item => item.id === parentId) : undefined;
          return !!parent && !parent.parentId;
        });
      let warned = false;
      // Released over the AI chat window the card is a reference to add, not something to move.
      let overChat = false;
      const move = (e: PointerEvent): void => {
        if (this.dragStale()) {
          this.endStaleDrag();
          return;
        }
        overChat =
          Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3 && !!this.chat?.hitTest(e.clientX, e.clientY);
        this.chat?.setDropHighlight(overChat);
        if (selecting) {
          travelled ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3;
          if (!group || !travelled || this.relevanceSortOn()) return;
          if (locked || timelineBlocked) {
            if (!warned) new Notice(t(locked ? "ui.merge_locked" : "ui.group_drag_timeline_top_level"));
            warned = true;
            return;
          }
          const zoom = this.map!.viewport.zoom;
          delta = { x: (e.clientX - start.x) / zoom, y: (e.clientY - start.y) / zoom };
          this.dragFrame ??= window.requestAnimationFrame(paint);
          return;
        }
        // While sorted the card sits at a display position; saving a drag would write that, so cards stay put.
        if (this.relevanceSortOn()) return;
        moved ||= Math.hypot(e.clientX - start.x, e.clientY - start.y) > 3;
        if (moved && locked) {
          if (!warned) new Notice(t("ui.merge_locked"));
          warned = true;
        }
        if (!moved || locked) return;
        position = {
          x: origin.x + (e.clientX - start.x) / this.map!.viewport.zoom,
          y: origin.y + (e.clientY - start.y) / this.map!.viewport.zoom
        };
        this.dragFrame ??= window.requestAnimationFrame(paint);
      };
      const settle = (): void => {
        this.chat?.setDropHighlight(false);
        this.dragging = false;
        this.dragOrigin = null;
        if (this.dragFrame !== null) window.cancelAnimationFrame(this.dragFrame);
        this.dragFrame = null;
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", finish);
        card.removeEventListener("pointercancel", finish);
        card.removeEventListener("lostpointercapture", finish);
        this.dragCleanup = null;
      };
      // The drop's own work comes first; a repaint that was asked for during the drag then runs once.
      const finish = (e: PointerEvent): void => {
        const stale = this.dragStale();
        settle();
        try {
          if (!stale) drop(e);
        } finally {
          if (this.renderAfterDrag && !this.dragging) {
            this.renderAfterDrag = false;
            if (!this.closed) this.render();
          }
        }
      };
      const drop = (e: PointerEvent): void => {
        // A plain click in selection mode is left to the click handler; a drag there must not toggle the card.
        if (selecting && !travelled) return;
        this.suppressClickUntil = Date.now() + 250;
        // The browser lost the pointer (or it was cancelled) without a release: put the card back.
        const putBack = (): void => {
          if (group) {
            placeGroup(0, 0);
            return;
          }
          card.style.left = `${origin.x}px`;
          card.style.top = `${origin.y}px`;
          edges?.update(origin.x, origin.y);
        };
        if (e.type === "pointercancel" || e.type === "lostpointercapture") {
          putBack();
          return;
        }
        if (overChat) {
          // Dropped on the chat: the card goes back where it was, nothing is written to the map.
          putBack();
          const ids = group ? [...group.keys()] : [node.id];
          for (const id of ids) if (this.map?.nodes.some(item => item.id === id)) this.chat?.addTopicReference(id);
          return;
        }
        if (selecting) {
          if (!group) return;
          if (locked || timelineBlocked || this.relevanceSortOn()) {
            putBack();
            return;
          }
          placeGroup(delta.x, delta.y);
          const { x: dx, y: dy } = delta;
          // One change for the whole group, so one undo puts every card back.
          this.enqueue(() =>
            this.mapChange(map => {
              for (const [id, from] of groupOrigins) {
                const current = map.nodes.find(n => n.id === id);
                if (!current) continue;
                current.x = Math.round(from.x + dx);
                current.y = Math.round(from.y + dy);
              }
            })
          );
          return;
        }
        if (moved && locked) {
          // The Notice already showed when the drag started.
        } else if (moved) {
          paint();
          this.enqueue(() =>
            this.mapChange(map => {
              const current = map.nodes.find(n => n.id === node.id);
              if (!current) return;
              // A first-level topic dragged in a timeline map is a change of order: re-order, then lay the map out again.
              const root = current.parentId ? map.nodes.find(n => n.id === current.parentId) : undefined;
              if (!map.aim && layoutOf(map).direction === "timeline" && root && !root.parentId) {
                const reordered = reorderTopLevel(map.nodes, root.id, current.id, position.x + card.offsetWidth / 2);
                map.nodes = arrangeMap(reordered, supersededAimNodeIds(map), this.cardHeightOf, layoutOf(map));
                return;
              }
              current.x = Math.round(position.x);
              current.y = Math.round(position.y);
            })
          );
        } else if (e.metaKey || e.ctrlKey) {
          const previous = this.selected,
            touched = [...this.multiSelected, node.id];
          // "Click A, then Cmd+click B" selects both: the single selected card seeds the multi-selection.
          if (this.canSelectTopics() && !this.multiSelected.size && previous && previous !== node.id)
            this.multiSelected.add(previous);
          if (this.multiSelected.has(node.id)) this.multiSelected.delete(node.id);
          else this.multiSelected.add(node.id);
          this.selected = node.id;
          // Two or more picked cards is topic selection: show its bar instead of leaving an invisible multi-selection.
          if (this.canSelectTopics() && this.multiSelected.size >= 2) {
            this.integrationMode = true;
            if (!this.closed) this.render();
            return;
          }
          this.commitSelection(previous, node.id, touched);
        } else {
          const previous = this.selected,
            touched = [...this.multiSelected];
          this.multiSelected.clear();
          this.selected = node.id;
          this.commitSelection(previous, node.id, touched);
          if (node.aimKind === "question") this.openAimAnswer(node);
          else if (this.plugin.detailsShown()) this.openDetails(node);
        }
      };
      this.dragCleanup = settle;
      card.addEventListener("pointermove", move);
      card.addEventListener("pointerup", finish);
      card.addEventListener("pointercancel", finish);
      card.addEventListener("lostpointercapture", finish);
    });
  }
  /** The picked cards that move together when one of them is dragged in selection mode, by id. */
  private groupDragMembers(node: MapNode, card: HTMLElement): Map<string, HTMLElement> {
    const members = new Map<string, HTMLElement>();
    for (const id of this.multiSelected) {
      const el = id === node.id ? (this.cardEls.get(id) ?? card) : this.cardEls.get(id);
      if (el && this.map?.nodes.some(item => item.id === id)) members.set(id, el);
    }
    return members;
  }
  /**
   * The edges touching a group of cards that move by the same offset. An edge with both ends in the group moves
   * with both; an edge with one end in the group keeps the other end where it was measured.
   */
  private groupDragEdges(group: Map<string, HTMLElement>): { update: (dx: number, dy: number) => void } {
    const nodes = this.map?.nodes ?? [];
    const directionOf = branchDirectionResolver(nodes, layoutOf(this.map).direction);
    const base = new Map<string, CardBox>();
    for (const [id, el] of group) base.set(id, boxOf(el));
    const boxFor = (id: string): CardBox | undefined => {
      const known = base.get(id);
      if (known) return known;
      const el = this.cardEls.get(id);
      return el ? boxOf(el) : undefined;
    };
    const shifted = (id: string, dx: number, dy: number): CardBox | undefined => {
      const box = boxFor(id);
      return box && group.has(id) ? { ...box, x: box.x + dx, y: box.y + dy } : box;
    };
    const tree: { key: string; parentId: string; childId: string; direction: string; depth: number }[] = [];
    for (const key of this.edgeEls.keys()) {
      const [parentId, childId] = key.split("\u0000");
      if (!group.has(parentId) && !group.has(childId)) continue;
      if (!boxFor(parentId) || !boxFor(childId)) continue;
      tree.push({ key, parentId, childId, direction: directionOf(parentId), depth: depthOf(nodes, childId) });
    }
    const linked: { key: string; fromId: string; toId: string }[] = [];
    for (const key of this.relationEls.keys()) {
      const [fromId, toId] = key.split("\u0000");
      if (!group.has(fromId) && !group.has(toId)) continue;
      if (boxFor(fromId) && boxFor(toId)) linked.push({ key, fromId, toId });
    }
    // Each fishbone spine touched by a member (the head, or a first-level topic of the head) follows the move.
    const spineIds = new Set<string>();
    for (const id of group.keys()) {
      const parentId = nodes.find(item => item.id === id)?.parentId;
      if (this.spineEls.has(id)) spineIds.add(id);
      else if (parentId && this.spineEls.has(parentId)) spineIds.add(parentId);
    }
    const spines = [...spineIds].flatMap(id => {
      const boxes = this.spineBoxes(id);
      return boxes ? [{ id, boxes }] : [];
    });
    return {
      update: (dx, dy) => {
        for (const { id, boxes } of spines) {
          const move = (item: string, box: CardBox): CardBox =>
            group.has(item) ? (shifted(item, dx, dy) ?? box) : box;
          this.placeSpine(id, undefined, {
            head: move(id, boxes.head),
            topics: boxes.topics.map(topic => ({ id: topic.id, box: move(topic.id, topic.box) }))
          });
        }
        for (const link of linked) {
          const path = this.relationEls.get(link.key);
          const from = shifted(link.fromId, dx, dy),
            to = shifted(link.toId, dx, dy);
          if (!path || !from || !to) continue;
          const d = relationPathData(from, to);
          path.setAttribute("d", d);
          this.relationHitEls.get(link.key)?.setAttribute("d", d);
          this.relationGapEls.get(link.key)?.setAttribute("d", d);
          this.placeRelationLabel(link.key, relationLabelPoint(from, to));
        }
        for (const edge of tree) {
          const path = this.edgeEls.get(edge.key);
          const parent = shifted(edge.parentId, dx, dy),
            child = shifted(edge.childId, dx, dy);
          if (!path || !parent || !child) continue;
          path.setAttribute(
            "d",
            edge.direction !== "right"
              ? treeEdgePathData(parent, child, edge.direction as LayoutKind, edge.depth)
              : edgePathData(parent.x + parent.width, parent.y + parent.height / 2, child.x, child.y + child.height / 2)
          );
        }
      }
    };
  }
  /** The map changed under a running drag: end it without writing anything, then run the repaint that waited for it. */
  private endStaleDrag(): void {
    this.dragCleanup?.();
    if (this.renderAfterDrag) {
      this.renderAfterDrag = false;
      if (!this.closed) this.render();
    }
  }
  /**
   * The edges touching one card, with the geometry they need already measured. `update` moves only those edges to
   * the dragged card's new position; every other edge stays untouched.
   */
  private dragEdges(id: string, card: HTMLElement): { update: (x: number, y: number) => void } {
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const mapDirection = layoutOf(this.map).direction;
    const nodes = this.map?.nodes ?? [];
    const directionOf = branchDirectionResolver(nodes, mapDirection);
    const touching: {
      key: string;
      direction: string;
      depth: number;
      dragIsParent: boolean;
      far: { x: number; y: number; width: number; height: number };
    }[] = [];
    for (const key of this.edgeEls.keys()) {
      const [parentId, childId] = key.split("\u0000");
      if (parentId !== id && childId !== id) continue;
      const other = this.cardEls.get(parentId === id ? childId : parentId);
      if (!other) continue;
      touching.push({
        key,
        direction: directionOf(parentId),
        depth: depthOf(nodes, childId),
        dragIsParent: parentId === id,
        far: { x: other.offsetLeft, y: other.offsetTop, width: other.offsetWidth, height: other.offsetHeight }
      });
    }
    const linked: { key: string; dragIsFrom: boolean; far: CardBox }[] = [];
    for (const key of this.relationEls.keys()) {
      const [fromId, toId] = key.split("\u0000");
      if (fromId !== id && toId !== id) continue;
      const other = this.cardEls.get(fromId === id ? toId : fromId);
      if (other) linked.push({ key, dragIsFrom: fromId === id, far: boxOf(other) });
    }
    // A fishbone spine ends at the leftmost bone joint, so dragging the head or one of its first-level topics moves it.
    const dragged = this.map?.nodes.find(node => node.id === id);
    const spineId = this.spineEls.has(id)
      ? id
      : dragged?.parentId && this.spineEls.has(dragged.parentId)
        ? dragged.parentId
        : null;
    // Measured once at drag start; `update` swaps in the dragged card's box instead of re-reading the DOM.
    const spineBoxes = spineId ? this.spineBoxes(spineId) : null;
    return {
      update: (x, y) => {
        if (spineId && spineBoxes) this.placeSpine(spineId, { id, box: { x, y, ...size } }, spineBoxes);
        for (const link of linked) {
          const path = this.relationEls.get(link.key);
          if (!path) continue;
          const mine = { x, y, ...size },
            from = link.dragIsFrom ? mine : link.far,
            to = link.dragIsFrom ? link.far : mine,
            d = relationPathData(from, to);
          path.setAttribute("d", d);
          this.relationHitEls.get(link.key)?.setAttribute("d", d);
          this.relationGapEls.get(link.key)?.setAttribute("d", d);
          this.placeRelationLabel(link.key, relationLabelPoint(from, to));
        }
        for (const edge of touching) {
          // A background synchronize may redraw the edges mid-drag; always move the current path elements.
          const path = this.edgeEls.get(edge.key);
          if (!path) continue;
          if (edge.direction !== "right") {
            const mine = { x, y, ...size };
            const kind = edge.direction as LayoutKind;
            path.setAttribute(
              "d",
              edge.dragIsParent
                ? treeEdgePathData(mine, edge.far, kind, edge.depth)
                : treeEdgePathData(edge.far, mine, kind, edge.depth)
            );
          } else if (edge.dragIsParent)
            path.setAttribute(
              "d",
              edgePathData(x + size.width, y + size.height / 2, edge.far.x, edge.far.y + edge.far.height / 2)
            );
          else
            path.setAttribute(
              "d",
              edgePathData(edge.far.x + edge.far.width, edge.far.y + edge.far.height / 2, x, y + size.height / 2)
            );
        }
      }
    };
  }
  /** The head and first-level topic boxes of one spine, read from the cards on screen. */
  private spineBoxes(headId: string): { head: CardBox; topics: { id: string; box: CardBox }[] } | null {
    const head = this.cardEls.get(headId);
    if (!head || !this.map) return null;
    const topics: { id: string; box: CardBox }[] = [];
    for (const node of this.canvasNodes()) {
      if (node.parentId !== headId) continue;
      const card = this.cardEls.get(node.id);
      if (card) topics.push({ id: node.id, box: boxOf(card) });
    }
    return { head: boxOf(head), topics };
  }
  /**
   * Sets one spine's path from the cards on screen; `moved` is a card being dragged, whose box is not yet in the DOM,
   * and `boxes` are the measured boxes a drag reuses so each move reads nothing from the DOM.
   */
  private placeSpine(
    headId: string,
    moved?: { id: string; box: CardBox },
    boxes: { head: CardBox; topics: { id: string; box: CardBox }[] } | null = this.spineBoxes(headId)
  ): void {
    const path = this.spineEls.get(headId);
    if (!path || !boxes) return;
    const boxFor = (id: string, box: CardBox): CardBox => (moved?.id === id ? moved.box : box);
    path.setAttribute(
      "d",
      fishboneSpinePathData(
        boxFor(headId, boxes.head),
        boxes.topics.map(topic => boxFor(topic.id, topic.box))
      )
    );
  }
  private drawEdges(): void {
    if (!this.edgesEl || !this.stageEl || !this.map) return;
    this.edgesEl.replaceChildren();
    this.edgeEls.clear();
    this.spineEls.clear();
    // A parent and child that also hold a relation show only the relation line, so one pair draws one line (decision 39).
    const related = new Set(
      this.relationsEnabled() ? (this.map.topicRelations ?? []).map(r => relationPairKey(r.from, r.to)) : []
    );
    const mapDirection = layoutOf(this.map).direction;
    const allNodes = this.map.nodes;
    const directionOf = branchDirectionResolver(allNodes, mapDirection);
    for (const node of this.canvasNodes()) {
      const parents = parentIdsForNode(node);
      for (const parentId of parents) {
        const parent = this.cardEls.get(parentId),
          child = this.cardEls.get(node.id);
        if (!parent || !child) continue;
        if (parentId === node.parentId && related.has(relationPairKey(parentId, node.id))) continue;
        const path = createSvg("path");
        // The edge follows its parent's arrangement, which a branch of its own may change.
        const direction = directionOf(parentId) as LayoutKind;
        path.setAttribute(
          "d",
          direction === "right"
            ? edgePathData(
                parent.offsetLeft + parent.offsetWidth,
                parent.offsetTop + parent.offsetHeight / 2,
                child.offsetLeft,
                child.offsetTop + child.offsetHeight / 2
              )
            : treeEdgePathData(boxOf(parent), boxOf(child), direction, depthOf(allNodes, node.id))
        );
        path.addClass("vam-edge");
        if (parentId !== node.parentId) path.addClass("vam-edge-convergence");
        if (!this.map.aim && !this.builtIn && this.notes.get(node.id)?.relevance?.tier === "side")
          path.addClass("vam-edge-side");
        // A mind map's own parent line is drawn lighter than the semantic lines (decision 35); AIM, the sample and the share viewer keep the accent line.
        else if (!this.map.aim && !this.builtIn && parentId === node.parentId)
          path.setAttribute("data-parent-line", "");
        this.edgesEl.appendChild(path);
        this.edgeEls.set(`${parentId}\u0000${node.id}`, path);
      }
    }
    // A fishbone also draws the main bone (spine) of each head that has a first-level topic on screen.
    if (mapDirection === "fishbone") {
      for (const node of this.canvasNodes()) {
        if (node.parentId || !this.cardEls.has(node.id) || this.spineEls.has(node.id)) continue;
        const path = createSvg("path");
        path.addClass("vam-edge");
        path.setAttribute("data-spine", "");
        if (!this.map.aim && !this.builtIn) path.setAttribute("data-parent-line", "");
        this.spineEls.set(node.id, path);
        this.placeSpine(node.id);
        if (path.getAttribute("d")) this.edgesEl.appendChild(path);
        else this.spineEls.delete(node.id);
      }
    }
    this.drawRelations();
    this.syncRelationClasses();
  }
  /**
   * Semantic links (`supports` and the other kinds, A -> B) in the same layer as the parent-child edges, each leaving
   * the nearest edge of A and entering the nearest edge of B. The kind sets the line pattern in styles.css; the
   * arrowhead is the plain one (all but "related", which has none) or the barred one ("contradicts"); "derives from"
   * is a double line (the outer line, then a canvas-coloured inner line). A link is not drawn when an end is off screen
   * (collapsed); the type of either end never hides a link, and a hand-written cycle is drawn as it is. An AIM map
   * draws none, and its file keeps the key.
   */
  private drawRelations(): void {
    this.relationEls.clear();
    this.relationHitEls.clear();
    this.relationLabelEls.clear();
    this.relationGapEls.clear();
    this.relationData.clear();
    this.relationLabelAt.clear();
    this.relationPainted.clear();
    this.relationExpanded.clear();
    if (!this.edgesEl || !this.map || !this.relationsEnabled()) return;
    const links: {
      from: HTMLElement;
      to: HTMLElement;
      key: string;
      kind: TopicRelation["kind"];
      relation: TopicRelation;
    }[] = [];
    for (const relation of this.map.topicRelations ?? []) {
      const from = this.cardEls.get(relation.from),
        to = this.cardEls.get(relation.to);
      if (!from || !to) continue;
      links.push({ from, to, key: relationIdentity(relation), kind: relation.kind, relation });
    }
    if (!links.length) return;
    const defs = createSvg("defs");
    defs.appendChild(this.relationMarker(this.relationMarkerId, false));
    defs.appendChild(this.relationMarker(this.relationBarMarkerId, true));
    this.edgesEl.appendChild(defs);
    for (const link of links) {
      const d = relationPathData(boxOf(link.from), boxOf(link.to)),
        marker =
          link.kind === "related"
            ? null
            : `url(#${link.kind === "contradicts" ? this.relationBarMarkerId : this.relationMarkerId})`;
      const path = createSvg("path");
      path.setAttribute("d", d);
      if (marker) path.setAttribute("marker-end", marker);
      path.addClass("vam-relation");
      path.addClass(`vam-relation-${link.kind}`);
      this.edgesEl.appendChild(path);
      this.relationEls.set(link.key, path);
      this.relationData.set(link.key, link.relation);
      if (link.kind === "derives_from") {
        // The inner line in the canvas colour leaves the outer one as two rails; its own arrowhead keeps the tip whole.
        const gap = createSvg("path");
        gap.setAttribute("d", d);
        if (marker) gap.setAttribute("marker-end", marker);
        gap.addClass("vam-relation-gap");
        this.edgesEl.appendChild(gap);
        this.relationGapEls.set(link.key, gap);
      }
      // The wide invisible path is what the pointer meets; the visible line and the parent-child edges ignore it.
      const hit = createSvg("path");
      hit.setAttribute("d", d);
      hit.addClass("vam-relation-hit");
      const key = link.key;
      hit.addEventListener("pointerdown", event => {
        // A press on a line is not a press on the empty canvas: no pan, no marquee, no clearing of the selection.
        event.stopPropagation();
        this.selectedRelation = key;
        this.syncRelationClasses();
      });
      // The click (not the press) opens the editor, so the dialog never opens under a pointer that is still down.
      hit.addEventListener("click", event => {
        event.stopPropagation();
        this.selectedRelation = key;
        this.syncRelationClasses();
        this.openRelationEditor(link.relation);
      });
      hit.addEventListener("pointerenter", () => {
        this.hoverRelation = key;
        this.syncRelationClasses();
      });
      hit.addEventListener("pointerleave", () => {
        if (this.hoverRelation === key) this.hoverRelation = null;
        this.syncRelationClasses();
      });
      this.edgesEl.appendChild(hit);
      this.relationHitEls.set(key, hit);
    }
    for (const link of links) {
      const label = createSvg("text");
      label.addClass("vam-relation-label");
      this.edgesEl.appendChild(label);
      this.relationLabelEls.set(link.key, label);
      this.placeRelationLabel(link.key, relationLabelPoint(boxOf(link.from), boxOf(link.to)));
    }
    // A relation that is gone (removed, merged, collapsed away) cannot stay selected.
    if (this.selectedRelation && !this.relationEls.has(this.selectedRelation)) this.selectedRelation = null;
    if (this.hoverRelation && !this.relationEls.has(this.hoverRelation)) this.hoverRelation = null;
    if (this.previewRelation && !this.relationEls.has(this.previewRelation)) this.previewRelation = null;
  }
  /**
   * An arrowhead whose tip sits exactly on the end of the line (`refX` is the tip), so it stops at the card edge. The
   * barred one puts the bar on the line before the arrowhead's base: past the tip it would sit under the opaque card.
   * Plain: viewBox 10 wide, base x 0, tip x 10. Barred: 14 wide, bar x 1, base x 4, tip x 14.
   */
  private relationMarker(id: string, barred: boolean): SVGMarkerElement {
    const marker = createSvg("marker"),
      arrow = createSvg("path"),
      width = barred ? 14 : 10,
      base = barred ? 4 : 0;
    marker.setAttribute("id", id);
    marker.setAttribute("viewBox", `0 0 ${width} 10`);
    marker.setAttribute("refX", String(width));
    marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", String(width));
    marker.setAttribute("markerHeight", "10");
    marker.setAttribute("markerUnits", "userSpaceOnUse");
    marker.setAttribute("orient", "auto");
    arrow.setAttribute("d", `M ${base} 0 L ${width} 5 L ${base} 10 z`);
    arrow.addClass("vam-relation-arrow");
    if (barred) {
      const bar = createSvg("path");
      bar.setAttribute("d", "M 1 0 L 1 10");
      bar.addClass("vam-relation-arrow-bar");
      marker.appendChild(arrow);
      marker.appendChild(bar);
    } else marker.appendChild(arrow);
    return marker;
  }
  /**
   * The text of a relation label: just the name normally; while the line is selected (or hovered) "Name: A → B"
   * ("—" for related) and, on a second line, the note cut to 60 characters with an ellipsis. Text only, never markup.
   */
  private paintRelationLabel(key: string, expanded: boolean): void {
    const label = this.relationLabelEls.get(key),
      link = this.relationData.get(key);
    if (!label || !link) return;
    const name = t(RELATION_NAME_KEY[link.kind]);
    if (!expanded) {
      label.textContent = name;
      return;
    }
    label.textContent = "";
    const titleOf = (id: string): string => this.notes.get(id)?.title ?? id,
      at = this.relationLabelAt.get(key),
      head = createSvg("tspan");
    head.textContent = t(
      link.kind === "related" ? "ui.relation_label_full_related_0_1_2" : "ui.relation_label_full_0_1_2",
      name,
      titleOf(link.from),
      titleOf(link.to)
    );
    if (at) head.setAttribute("x", String(at.x));
    label.appendChild(head);
    if (link.description) {
      const note = createSvg("tspan"),
        chars = Array.from(link.description);
      note.textContent =
        chars.length > RELATION_LABEL_NOTE_MAX
          ? `${chars.slice(0, RELATION_LABEL_NOTE_MAX).join("")}…`
          : link.description;
      if (at) note.setAttribute("x", String(at.x));
      note.setAttribute("dy", "1.3em");
      label.appendChild(note);
    }
  }
  private placeRelationLabel(key: string, point: { x: number; y: number }): void {
    this.relationLabelAt.set(key, point);
    const label = this.relationLabelEls.get(key);
    if (!label) return;
    label.setAttribute("x", String(point.x));
    label.setAttribute("y", String(point.y));
    // The tspans of an expanded label carry their own x; they follow the line.
    for (const part of Array.from(label.children)) part.setAttribute("x", String(point.x));
  }
  /**
   * Repaints the relation highlights from the current state, without touching the DOM structure: with topics selected
   * (single or multiple), the semantic lines touching them are `is-related` and the rest `is-dimmed` (parent-child
   * edges stay as they are); the selected (or panel-previewed) line is `is-selected` and shows its name, as does a
   * hovered line; both end cards get `is-relation-end`.
   */
  private syncRelationClasses(): void {
    const chosen = new Set(this.multiSelected);
    if (this.selected) chosen.add(this.selected);
    const ends = new Set<string>();
    for (const [key, path] of this.relationEls) {
      const [fromId, toId] = key.split("\u0000");
      const related = chosen.has(fromId) || chosen.has(toId),
        active = key === this.selectedRelation || key === this.previewRelation;
      path.toggleClass("is-related", related);
      path.toggleClass("is-dimmed", chosen.size > 0 && !related);
      path.toggleClass("is-selected", active);
      const expanded = active || key === this.hoverRelation;
      this.relationLabelEls.get(key)?.toggleClass("is-expanded", expanded);
      if (this.relationExpanded.has(key) !== expanded || !this.relationPainted.has(key)) {
        this.paintRelationLabel(key, expanded);
        this.relationPainted.add(key);
        if (expanded) this.relationExpanded.add(key);
        else this.relationExpanded.delete(key);
      }
      if (active) {
        ends.add(fromId);
        ends.add(toId);
      }
    }
    for (const id of new Set([...this.relationEndIds, ...ends]))
      this.cardEls.get(id)?.toggleClass("is-relation-end", ends.has(id));
    this.relationEndIds = ends;
  }
  /** A panel row stands for its line: focusing it selects the line, hovering previews it with the same highlight and name. */
  private bindRelationRow(row: HTMLElement, link: TopicRelation, ariaLabel: string): void {
    const key = relationIdentity(link);
    row.tabIndex = 0;
    row.setAttr("role", "group");
    row.setAttr("aria-label", ariaLabel);
    row.addEventListener("focus", () => {
      this.selectedRelation = key;
      this.syncRelationClasses();
    });
    row.addEventListener("blur", () => {
      if (this.selectedRelation === key) this.selectedRelation = null;
      this.syncRelationClasses();
    });
    row.addEventListener("mouseenter", () => {
      this.previewRelation = key;
      this.syncRelationClasses();
    });
    row.addEventListener("mouseleave", () => {
      if (this.previewRelation === key) this.previewRelation = null;
      this.syncRelationClasses();
    });
  }
  /**
   * Content template for an AI update of this topic: this run's choice, then the topic, map and workspace defaults.
   * Only an explicit choice is written to the topic; a topic template that no longer exists is reported once and cleared.
   */
  private async detailTemplateFor(node: MapNode, chosenId?: string, chosenToneId?: string): Promise<DetailTemplate> {
    if (chosenToneId) await this.plugin.repo.updateNote(node.path, { toneId: chosenToneId });
    if (chosenId) await this.plugin.repo.updateNote(node.path, { detailTemplateId: chosenId });
    const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    const { template, missing } = this.resolveTopicTemplate(note, chosenId);
    if (note.detailTemplateId && missing.includes(note.detailTemplateId)) {
      new Notice(t("ui.detail_template_missing_0", note.detailTemplateId));
      await this.plugin.repo.updateNote(node.path, { detailTemplateId: "" });
    }
    return template;
  }
  /** Resolves the topic's content template without notifying or writing anything (see detailTemplateFor). */
  private resolveTopicTemplate(note: Note, chosenId?: string): { template: DetailTemplate; missing: string[] } {
    const settings = this.plugin.settings;
    return resolveTemplate(
      settings.detailTemplates,
      [chosenId, note.detailTemplateId, this.map?.detailTemplateId, settings.defaultDetailTemplateId],
      noteLanguageOf(settings.language)
    );
  }
  /**
   * Template for content that has no topic choice of its own (new integrated topics, child contributions); a dialog
   * choice comes first.
   */
  private mapDetailTemplate(language: ContentLanguage, chosenId?: string): DetailTemplate {
    const settings = this.plugin.settings;
    return templateInLanguage(
      resolveTemplate(
        settings.detailTemplates,
        [chosenId, this.map?.detailTemplateId, settings.defaultDetailTemplateId],
        noteLanguageOf(settings.language)
      ).template,
      language
    );
  }
  /**
   * The model and reasoning a run really uses: a run-once choice first (never written to the topic), otherwise the
   * topic's own resolution that `readNote` already did.
   */
  private async modelFor(
    note: Pick<Note, "model" | "reasoning">,
    path: string,
    runOnce?: RunOnceModel
  ): Promise<{ model: string; reasoning?: ReasoningLevel }> {
    if (!runOnce?.model.trim()) return { model: note.model, reasoning: note.reasoning };
    const { model, reasoning } = await this.plugin.repo.resolveTopicModel(path, this.map ?? undefined, runOnce);
    return { model, reasoning };
  }
  private async runAgent(
    node: MapNode,
    done?: (result: AiResult) => void,
    failed?: (message: string) => void,
    overrides?: Partial<TaskContext>,
    onLaunchAccepted?: () => void,
    runOnce?: RunOnceModel
  ): Promise<AgentTaskHandle | null> {
    const taskPath = node.path;
    const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
    const used = await this.modelFor(note, node.path, runOnce);
    if (!(overrides?.task ?? note.prompt)) {
      const message = t("ui.enter_a_question_or_task_for_ai_first");
      if (failed) failed(message);
      else new Notice(message);
      return null;
    }
    if (this.plugin.running.has(node.path)) {
      failed?.(t("ui.ai_running_ai"));
      return null;
    }
    const detailTemplate = templateInLanguage(
      overrides?.detailTemplate ?? (await this.detailTemplateFor(node)),
      overrides?.outputLanguage ?? this.plugin.settings.language
    );
    const context: TaskContext = withThinkingOrigin(
      {
        title: note.title,
        summary: summaryForPrompt(note.summary, overrides?.outputLanguage ?? this.plugin.settings.language),
        rules: "",
        detail: note.detail,
        task: note.prompt,
        ancestors: await this.ancestorContext(node, overrides?.outputLanguage ?? this.plugin.settings.language),
        workingFindings: note.newFindings,
        sourceContext: "",
        mode: "task",
        researchMode: note.researchMode,
        researchDepth: "normal",
        visualMode: note.visualMode,
        ...this.toneField(note, overrides),
        ...overrides,
        detailTemplate,
        addCharts: overrides?.addCharts ?? true
      },
      note
    );
    const language = this.plugin.settings.language;
    this.plugin.pendingSuggestions.delete(node.path);
    // A diagram job still running for the previous result of this note must not land on the new run.
    this.plugin.abortChartJobs(node.path);
    this.plugin.running.add(node.path);
    const controller = new AbortController();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides?.signal?.aborted) controller.abort();
    else overrides?.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    this.plugin.activeTasks.set(taskPath, controller);
    // Stage, seconds and the unsaved preview of this run; an attempt id from the service replaces the placeholder.
    const progress = this.plugin.researchProgress;
    let progressAttempt = "starting";
    progress?.begin(taskPath, progressAttempt, Date.now(), used.model);
    const observer: ResearchObserver = {
      onAttempt: id => {
        progressAttempt = id;
        progress?.newAttempt(taskPath, id, Date.now());
      },
      onStage: (id, stage, query) => progress?.stage(taskPath, id, stage, Date.now(), query),
      onPreview: (id, fields) => progress?.preview(taskPath, id, fields ?? {}),
      onSlow: (id, slow, resend) => progress?.markSlow(taskPath, id, slow, resend)
    };
    const releaseStartup = (): void => {
      progress?.end(taskPath, progressAttempt);
      overrides?.signal?.removeEventListener("abort", abortFromTaskModal);
      if (this.plugin.activeTasks.get(taskPath) === controller) this.plugin.activeTasks.delete(taskPath);
      this.plugin.running.delete(taskPath);
    };
    let startupStatusAttempted = false;
    try {
      startupStatusAttempted = true;
      await this.plugin.repo.updateNote(node.path, { status: "running" });
      await this.hydrate();
      this.render();
      if (controller.signal.aborted) {
        try {
          await this.plugin.repo.updateNote(node.path, { status: note.status });
        } finally {
          releaseStartup();
        }
        return null;
      }
    } catch (error) {
      try {
        if (startupStatusAttempted) await this.plugin.repo.updateNote(node.path, { status: note.status });
      } catch {
        /* Keep the startup error; the registered task still must be released. */
      } finally {
        releaseStartup();
      }
      throw error;
    }
    // Leave the mutation queue immediately: independent branches can run concurrently.
    let exchangeId = "";
    let resolveAccepted!: (accepted: boolean) => void;
    const acceptedPromise = new Promise<boolean>(resolve => {
      resolveAccepted = resolve;
    });
    let requestAccepted = false;
    const markAccepted = (): void => {
      if (requestAccepted) return;
      requestAccepted = true;
      resolveAccepted(true);
      onLaunchAccepted?.();
    };
    const completion = this.plugin
      .askModel(
        context,
        used.model,
        used.reasoning,
        controller.signal,
        id => {
          exchangeId = id;
        },
        markAccepted,
        undefined,
        observer
      )
      .then(result =>
        this.plugin.mutate(async () => {
          // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
          progress?.end(taskPath, progressAttempt);
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          const stale =
            latest.thinkingOrigin !== note.thinkingOrigin ||
            latest.title !== note.title ||
            latest.prompt !== note.prompt ||
            latest.rules !== note.rules ||
            latest.detail !== note.detail ||
            latest.summary !== note.summary ||
            latest.model !== note.model ||
            latest.reasoning !== note.reasoning ||
            latest.researchMode !== note.researchMode ||
            latest.visualMode !== note.visualMode ||
            latest.sourcePaths.join("\n") !== note.sourcePaths.join("\n") ||
            JSON.stringify(latest.referencePaths) !== JSON.stringify(note.referencePaths);
          if (controller.signal.aborted || stale) {
            await this.plugin.repo.updateNote(node.path, { status: note.status });
            if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled)
              this.plugin.exchanges?.failed(
                exchangeId,
                t(stale ? "log.stale_result_not_written" : "log.stopped_result_not_written")
              );
            if (stale) {
              if (failed) failed(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
              else new Notice(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
            }
            return;
          }
          await this.plugin.repo.updateNote(
            node.path,
            {
              summary: result.summary,
              detail: canonicalDetail(
                result.detail,
                noteLanguageOf(context.outputLanguage ?? this.plugin.settings.language),
                context.detailTemplate
              ),
              visualReferences: visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language)),
              newFindings: "",
              status: "completed",
              // The topic remembers the mode of its latest research (Quick is stored as local).
              ...(context.researchMode ? { researchMode: context.researchMode } : {}),
              ...formatIssuesPatch(result.formatIssues, language)
            },
            { detailTemplate: context.detailTemplate }
          );
          const saved = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          this.recordNoteWrite(
            node.path,
            { ...latest, status: note.status },
            saved,
            [
              "summary",
              "detail",
              "visualReferences",
              "newFindings",
              "previewSection",
              "previewInitialized",
              "previewAutoHash",
              "status",
              "lastError",
              "researchMode"
            ],
            t("ui.research_task")
          );
          if (exchangeId && this.plugin.settings.aiExchangeLoggingEnabled) this.plugin.exchanges?.completed(exchangeId);
          for (const view of this.plugin.views()) if (view !== this) view.history.clear();
          this.queueCharts({
            path: node.path,
            saved,
            context,
            detail: saved.detail,
            formatIssues: result.formatIssues,
            model: used.model,
            language: context.outputLanguage ?? this.plugin.settings.language,
            template: context.detailTemplate
          });
          if (result.suggestions.length) {
            this.plugin.pendingSuggestions.set(
              node.path,
              result.suggestions
                .slice(0, 7)
                .map(item => ({ ...item, thinkingOriginBaseline: originBaseline(note.thinkingOrigin) }))
            );
            try {
              await (this.plugin.pendingSuggestions as PendingSuggestions).flush?.();
            } catch (error) {
              const message = this.plugin.recordFailure(t("log.expansion_suggestions_save_failed"), error);
              new Notice(message);
            }
          }
          done?.(result);
        })
      )
      .catch(error =>
        this.plugin.mutate(async () => {
          progress?.end(taskPath, progressAttempt);
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            await this.plugin.repo.updateNote(node.path, { status: note.status });
            if (failed) failed(t("ui.research_stopped_existing_content_was_preserved"));
            else new Notice(t("ui.research_stopped_existing_content_was_preserved"));
            return;
          }
          console.error("Visual Agent Map AI task", error);
          if (
            exchangeId &&
            this.plugin.settings.aiExchangeLoggingEnabled &&
            this.plugin.exchanges?.getEntries().find(item => item.id === exchangeId)?.status === "parsed"
          )
            this.plugin.exchanges.failed(
              exchangeId,
              t("log.topic_write_failed_0", error instanceof Error ? error.message : String(error))
            );
          await this.plugin.repo.updateNote(node.path, { status: "error", lastError: failureReason(error) });
          const message = this.plugin.recordFailure(t("log.ai_task_failed"), error);
          if (failed) failed(message);
          else new Notice(message);
        })
      )
      .finally(() => {
        progress?.end(taskPath, progressAttempt);
        overrides?.signal?.removeEventListener("abort", abortFromTaskModal);
        if (this.plugin.activeTasks.get(taskPath) === controller) this.plugin.activeTasks.delete(taskPath);
        this.plugin.running.delete(taskPath);
        for (const view of this.plugin.views())
          view.enqueue(async () => {
            await view.hydrate();
            view.render();
          });
      })
      .catch(() => {});
    const accepted = await Promise.race([acceptedPromise, completion.then(() => false)]);
    if (!accepted) {
      await completion;
      return null;
    }
    return { finished: completion };
  }
}
