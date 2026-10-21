import { chooseAimContentLanguage, resolveAimContentLanguage } from "../aim/content-language";
import { backgroundResultNotice, renderBackgroundStatus } from "../../ui/background-run";
import { PromptPresetsModal } from "../../ui/modals/prompt-presets-modal";
import { AimClarificationModal } from "../../ui/modals/aim-clarification-modal";
import { withThinkingOrigin } from "./thinking-origin";
import { createHash, randomUUID } from "node:crypto";
import type VisualAgentMapPlugin from "../../main";
import { t, topicStatusLabel, translate, type TranslationKey, type UiLanguage } from "../../i18n";
import { MarkdownRenderer, ItemView, Menu, Modal, Notice, TFile, WorkspaceLeaf, setIcon, setTooltip } from "obsidian";
import { readMarkdownFile, type ReferenceGroup } from "../../ai/reference-materials";
import { NameModal } from "../../ui/modals/name-modal";
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
  type MapDocument,
  type MapNode,
  parentIdsForNode,
  removeNodes,
  supersededAimNodeIds,
  visibleNodes
} from "../../map-model";
import { arrangeMap, arrangeNewBranch, arrangeNewTree, medianHeight } from "../../map-layout";
import { inLanguage, NONE } from "../../core/steps/_shared/fragments";
import { mergeRepair } from "../../core/steps/task/fragments";
import { checkMergePreservation, findingList, type MergeCheckResult } from "../../core/steps/task/merge-check";
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
  rebaseMapNotePaths,
  type Note,
  type NotePatch,
  type TopicInfo,
  type TopicState,
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
import { DEFAULT_TONE_ID, listPresets, resolvePreset, resolveToneText } from "../../ai/prompt-presets";
import { matchPreset, NOTE_STYLE_PRESETS, styleLabel } from "./note-style";
import type { AiResult, Suggestion, TaskContext } from "../../ai/types";
import { previewMetrics } from "../../ui/preview-utils";
import { BUILTIN_SAMPLE_ID, builtInSample, SAMPLE_TOUR_VERSION } from "../../builtin-sample";
import {
  normalizeRelevanceContext,
  normalizeRelevanceGoal,
  normalizeRelevanceLevel,
  RELEVANCE_CONTEXT_MAX_LENGTH,
  RELEVANCE_GOAL_MAX_LENGTH,
  RELEVANCE_LEVELS,
  type NoteRelevance,
  type RelevanceLevel,
  type RelevanceTier
} from "../../note-values";
import { RELEVANCE_LABEL, renderRelevanceTagButton } from "./relevance-tag";
import { relevanceDisplayNodes } from "./relevance-order";
import { fitViewport, focusViewport, initialViewport, insetFromRects } from "./viewport-inset";
import { RelevanceSummaryModal } from "./relevance-summary-modal";
import { relevanceMode, relevanceModeAfterWrite, type RelevanceMode, type RelevancePin } from "./relevance-pins";
import { PendingSuggestions } from "../../pending-suggestions";
import { createAimMap } from "../aim/create-map";
import { addOutlineToMap, createOutlineMap, type OutlineNode } from "./outline-import";
import {
  OutlineImportModal,
  type OutlineDraftInputs,
  type OutlineDraftPrefill,
  type OutlineGenerator,
  type OutlineImportRequest,
  type OutlineImportTarget,
  type OutlinePlacement
} from "./outline-import-modal";
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
  RelevanceGradeResult,
  RelevanceGradeRun
} from "../../core/relevance-grade-service";
import { renderTopicTree } from "../../ui/topic-tree";
import { TopicTreeModal } from "../../ui/modals/topic-tree-modal";
import type { FieldLinks, ModelChoices } from "./research-fields";
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
  imageReferencesFromMarkdown,
  PartialChildBatchError,
  AgentTaskHandle,
  TaskSourceSettings,
  NextStepModal,
  type BackgroundHooks,
  type PendingOutline,
  outlineProposals,
  type QuickOutline,
  type SynthesisObserver,
  armDiscard,
  renderProposalList,
  ChildProposalModal,
  MapConflictModal,
  NoteCollectionModal,
  TopicPickerModal
} from "./modals";
export const VIEW_TYPE = "visual-agent-map-view";
interface Action {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  label?: string;
}
/** Message of any thrown value, without relying on instanceof Error (errors may cross realms). */
function errorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" ? message : String(error);
}
/** The built-in Standard and Textbook templates follow the output language, as the fixed Detail headings always did. */
function templateInLanguage(template: DetailTemplate, language: UiLanguage): DetailTemplate {
  return isBuiltinTemplateId(template.id)
    ? builtinTemplates(language).find(item => item.id === template.id)!
    : template;
}
/** Unmet section counts to store on the topic; undefined (no count check ran) clears an earlier mark. */
function formatIssuesPatch(
  issues: CountIssue[] | undefined,
  language: UiLanguage
): Pick<NotePatch, "detailFormatIssues"> {
  return { detailFormatIssues: (issues ?? []).map(issue => countIssueText(issue, language)) };
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
interface FileMove {
  activePath: string;
  parkedPath: string;
  topicId: string;
  parkedState: TopicState;
}
/** One completed file move of a merge, with what a rollback needs to put the note and its lifecycle back. */
interface MergeMove {
  from: string;
  to: string;
  topicId: string;
  restoreMapId: string;
  restoreState: TopicState;
}
/** What a merge changed, kept by its history entry so undo and redo move the same files between fixed paths. */
interface MergeState {
  before: MapDocument;
  after: MapDocument;
  newId: string;
  newActive: string;
  /** Where the merged note waits while the merge is undone; chosen by the first undo, then reused. */
  newParked: string | null;
  sources: FileMove[];
}
/** The note fields a parent-mode undo or redo checks before touching anything: what the user can see and edit. */
const MERGE_GUARD_FIELDS = ["title", "summary", "detail", "status"] as const;
type MergeGuard = Pick<Note, (typeof MERGE_GUARD_FIELDS)[number]>;
/** What a merge into a parent topic changed: the parent keeps its card, only its note content and the subtopics move. */
interface ParentMergeState {
  before: MapDocument;
  after: MapDocument;
  /** The parent topic's note, and its exact text before the merge (undo writes it back verbatim). */
  targetPath: string;
  beforeText: string;
  patch: NotePatch;
  detailTemplate: DetailTemplate;
  guardBefore: MergeGuard;
  guardAfter: MergeGuard;
  sources: FileMove[];
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
/** How long the "merged, can undo" Notice stays, so its Undo button can be used. */
const MERGE_DONE_NOTICE_MS = 15000;
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
/** Identifies one relevance grading run, so a late result can tell it is no longer the current one. */
let relevanceRunToken = 0;
let relevancePanelSeq = 0;
/** Maps whose cards are displayed sorted by relevance. Memory only: never written to a note or Map.md. */
const relevanceSortedMaps = new Set<string>();
/** Path data for the curve from a parent card's right edge to a child card's left edge. */
function edgePathData(x1: number, y1: number, x2: number, y2: number): string {
  const bend = Math.max(60, Math.abs(x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/** One planned subtopic of the running AIM branch, as the map shows it before its research note exists. */
type AimTargetProgress = {
  title: string;
  state: "queued" | "searching" | "done" | "skipped";
  searches: number;
  startedAt?: number;
};

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

export class VisualAgentMapView extends ItemView {
  private map: MapDocument | null = null;
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
  private zoomLabel: HTMLElement | null = null;
  private refreshTimer: number | null = null;
  private viewportTimer: number | null = null;
  private hoverTimer: number | null = null;
  private hoverCard: HTMLElement | null = null;
  private integrationMode = false;
  private dragging = false;
  /** Ends the drag in progress (listeners, pending frame, flag); set only while a card is being dragged. */
  private dragCleanup: (() => void) | null = null;
  private dragFrame: number | null = null;
  /** A viewport write is already waiting in the queue; it reads the viewport when it runs, so later saves join it. */
  private viewportQueued = false;
  private edgeEls = new Map<string, SVGPathElement>();
  private suppressClickUntil = 0;
  /** Node whose card should hold keyboard focus once the next render finishes. */
  private focusNodeId: string | null = null;
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
  private aimProgressTimer: number | null = null;
  private aimProgressRenderTimer: number | null = null;
  private aimFailedReports = new Map<string, { runId: string; diagnosticNotePath: string }>();
  private aimAnswerRequestIds = new Map<string, string>();
  constructor(
    leaf: WorkspaceLeaf,
    private plugin: VisualAgentMapPlugin
  ) {
    super(leaf);
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
  async onOpen(): Promise<void> {
    this.closed = false;
    const epoch = ++this.aimViewEpoch;
    this.mapOpenEpoch++;
    this.contentEl.addClass("vam-view");
    this.contentEl.tabIndex = 0;
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
    this.registerDomEvent(this.contentEl, "keydown", event => {
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("input, textarea, select, [contenteditable=true]")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        this.enqueue(() => this.travel(event.shiftKey));
      }
      if (event.key === "Escape") {
        const previous = this.selected,
          touched = [...this.multiSelected];
        const wasSelecting = this.integrationMode;
        this.selected = null;
        this.multiSelected.clear();
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
  async onClose(): Promise<void> {
    this.closed = true;
    this.plugin.releaseOutline(this);
    this.relevancePanelCleanup?.();
    this.relevancePanelCleanup = null;
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
      const sample = builtInSample(this.plugin.settings.language);
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
    if (typeof document === "undefined" || !this.contentEl.contains(document.activeElement)) {
      this.render();
      return;
    }
    const focusedContainer = document.activeElement === this.contentEl;
    const before = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
    );
    const activeIndex = before.indexOf(document.activeElement as HTMLElement);
    const active = document.activeElement as HTMLInputElement;
    const selection =
      active.tagName === "INPUT" || active.tagName === "TEXTAREA"
        ? ([active.selectionStart, active.selectionEnd] as const)
        : null;
    this.render();
    const after = Array.from(
      this.contentEl.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")
    );
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
  private async persist(): Promise<void> {
    if (!this.builtIn && this.map && this.path) await this.plugin.repo.saveMap(this.path, this.map);
  }
  private async hydrate(isCurrent: () => boolean = () => true): Promise<void> {
    this.aimFailedReports.clear();
    if (this.builtIn) {
      if (isCurrent()) {
        this.notes = builtInSample(this.plugin.settings.language).notes;
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
    if (this.viewportTimer !== null) {
      window.clearTimeout(this.viewportTimer);
      this.viewportTimer = null;
      await this.persistViewport();
      if (!isCurrent()) return;
    }
    if (path !== this.path) {
      this.stopAimProgress();
      this.abortRelevanceGrade();
    }
    let map = await this.plugin.repo.readMap(path);
    if (!isCurrent()) return;
    if (map.aim?.creationId && map.aim.rootDraft) {
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
    await this.hydrate(isCurrent);
    if (!isCurrent()) return;
    this.render();
    this.app.workspace.requestSaveLayout();
  }
  openAimStart(): void {
    if (this.closed) return;
    const epoch = this.aimViewEpoch;
    const isCurrent = () => !this.closed && this.aimViewEpoch === epoch;
    const availableModels = typeof this.plugin.availableModels === "function" ? this.plugin.availableModels() : [];
    const configuredModel = this.plugin.settings.cliModel?.trim() || "gpt-5.6-luna";
    const configuredReasoning = normalizeReasoningLevel(this.plugin.settings.cliReasoning);
    const defaultReasoning =
      configuredReasoning === "medium" || configuredReasoning === "high" ? configuredReasoning : "low";
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
    language: UiLanguage = this.plugin.settings.language
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
    return [...builtinTemplates(settings.language), ...settings.detailTemplates].map(({ id, name }) => ({ id, name }));
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
      this.defaultStyleLabel()
    ).open();
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
        const model = settings.cliModel;
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
                ...request,
                language: settings.language,
                contentLanguage: chooseAimContentLanguage(settings.language, request.topic),
                model,
                reasoning: normalizeReasoningLevel(settings.cliReasoning)
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
        ...(merge.state === "running" ? { onStop: () => this.stopMergeTask(merge), stopLabel: t("ui.merge_stop") } : {})
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
        const result = await this.plugin.outlineGeneration.generate(
          {
            topic: note.title,
            presetText: request.requirements ? `${preset.text}\n\n${request.requirements}` : preset.text,
            language: request.language,
            model: note.model,
            reasoning: normalizeReasoningLevel(note.reasoning ?? settings.cliReasoning),
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
          // Shallow research stays Quick (see the dialog); every other research choice is the dialog's.
          ...(options.shallowResearch
            ? {
                researchDepth: "fast" as const,
                researchOptions: {
                  // Quick research of the new topics reads local context only unless the dialog asks for the web.
                  researchMode: options.shallowWebSearch ? options.researchMode : ("local" as const),
                  referenceGroups: options.referenceGroups ?? [],
                  visualMode: options.shallowWebSearch ? options.visualMode : ("off" as const),
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
        const model = settings.cliModel;
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
                contentLanguage: chooseAimContentLanguage(settings.language, rootQuestion),
                model,
                reasoning: normalizeReasoningLevel(settings.cliReasoning)
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
      if (this.relevancePanelOpen) this.closeRelevancePanel(true);
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
  private closeRelevancePanel(refocus: boolean): void {
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
    if (this.plugin.relevanceGrades.get(this.path)?.status === "running") return;
    if (!this.relevanceToolsEl) return;
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
    const showMode = (): void =>
      submitButton.setText(
        t(planMode() === "recalibrate" ? "ui.relevance_recalibrate_button" : "ui.relevance_grade_button")
      );
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
      this.closeRelevancePanel(refocus);
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
        const next = event.relatedTarget as Node | null;
        if (!next || (!panel.contains(next) && next !== this.relevanceButtonEl)) finish(false, false);
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
      status: "running"
    };
    // Claim the map before the first await, so a second Enter cannot start another run.
    this.plugin.relevanceGrades.set(mapPath, run);
    this.startedRelevance = true;
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
        // Goal, level and context are one undo step; none changed means nothing to undo.
        if (!setupChanged) return;
        this.history.push({
          label: t("ui.relevance_goal_history_label"),
          undo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, previous),
          redo: () => this.plugin.repo.restoreRelevanceGoal(mapPath, next)
        });
        this.updateHistoryButtons();
      });
      const model = settings.cliModel;
      // The run stays "running" (the map is locked and Stop works) but the bar must not claim grading while the
      // usage notice waits for an answer.
      run.awaitingUsage = true;
      this.refreshRelevance();
      const started = await this.plugin.confirmAiUsage(model, async () => {
        // Stopped, or the map changed, while the usage dialog was open.
        if (!this.relevanceRunIsCurrent(run, mapPath) || !this.map) return;
        run.awaitingUsage = false;
        this.refreshRelevance();
        basis = buildStructureReviewNodes(this.map.nodes, id => this.describeForReview(id));
        // Pinned (hand-set) cards are the learner's: the AI sees them as anchors and never grades them.
        pins = this.relevancePinList();
        const request = {
          goal,
          ...(level ? { level } : {}),
          ...(context ? { context } : {}),
          nodes: basis,
          language: settings.language,
          contentLanguage: chooseAimContentLanguage(settings.language, this.map.title),
          model,
          reasoning: normalizeReasoningLevel(settings.cliReasoning),
          ...(pins.length ? { pins } : {})
        };
        const hooks = {
          onRepair: (_round: number, kind: string) => {
            repairs.push(kind);
            if (!this.relevanceRunIsCurrent(run, mapPath)) return;
            run.repairing = true;
            this.refreshRelevance();
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
      await this.plugin.mutate(() => this.applyRelevanceGrade(run, mapPath, basis, graded, { mode, pins, repairs }));
      this.refreshRelevance();
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
    const startedAt = Date.now();
    const repo = this.plugin.repo;
    const fresh = new Map<string, Note>();
    for (const node of this.map.nodes) {
      try {
        fresh.set(node.id, await repo.readNote(node.path));
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
        const after = { tier: item.tier, reason: item.reason };
        const before = note.relevance ? { tier: note.relevance.tier, reason: note.relevance.reason } : undefined;
        if (before && before.tier === after.tier && before.reason === after.reason) {
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
      a === b || (!!a && !!b && a.tier === b.tier && a.reason === b.reason && !!a.manual === !!b.manual);
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
              await repo.writeRelevance(entry.path, { tier: entry.tier, reason: "", manual: true });
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
    this.plugin.runMutation(() =>
      this.plugin.repo.writeRelevance(node.path, tier ? { tier, reason: "", manual: true } : null)
    );
  }
  private stopRelevanceGrade(): void {
    const run = this.plugin.relevanceGrades.get(this.path);
    if (!run || run.status !== "running" || run.writing) return;
    run.status = "stopped";
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
        this.cardHeightOf
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
          map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf);
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
        map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf);
      }, false)
    );
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
    menu.addItem(item =>
      item
        .setTitle(t("ui.auto_layout"))
        .setIcon("workflow")
        .onClick(() => this.autoLayout())
    );
    menu.showAtMouseEvent(event);
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
    const model = (request.shallowResearch && request.model) || this.plugin.settings.cliModel;
    const settings = this.plugin.settings;
    const { template } = resolveTemplate(
      settings.detailTemplates,
      [request.detailTemplateId, settings.defaultDetailTemplateId],
      settings.language
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
        Boolean(request.shallowResearch && request.model && request.model !== settings.cliModel)
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
          researchMode: "research",
          researchDepth: request.researchDepth ?? "fast",
          referenceGroups: [],
          visualMode: "off"
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
    let model = settings.cliModel;
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
          ? inheritModel((await repo.readNote(parent.path, map)).model, settings.cliModel)
          : settings.cliModel;
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
        if (!created.length) return;
        for (const node of created) {
          try {
            this.notes.set(node.id, await repo.readNote(node.path, { ...map, nodes: [...map.nodes, ...created] }));
          } catch {
            // The note exists; the view reloads it on the next hydrate.
          }
        }
        const top = created[0];
        const ids = new Set(created.map(node => node.id));
        // The view's normal mutation path: conflict check, Map.md save, undo history and Reference Links.
        try {
          await this.mapChange(next => {
            next.nodes.push(...created);
            // The map may have been swapped for the file version by the conflict window: without the parent there,
            // the outline becomes a new tree rather than a node pointing at a missing parent.
            const owner = parent ? next.nodes.find(node => node.id === parent.id && !ids.has(node.id)) : undefined;
            const outlineTop = next.nodes.find(node => node.id === top.id)!;
            if (owner) {
              owner.collapsed = false;
              next.nodes = arrangeNewBranch(next.nodes, owner.id, ids, this.cardHeightOf);
            } else {
              outlineTop.parentId = null;
              next.nodes = arrangeNewTree(next.nodes, top.id, ids, this.cardHeightOf);
            }
          });
        } catch (error) {
          // The notes exist but the map does not hold them: list them, like a new map whose Map.md cannot be saved.
          state.saveFailed = true;
          new Notice(
            t(
              "ui.outline_import_map_save_failed",
              `${errorMessage(error)} (${created.map(node => node.path).join(", ")})`
            )
          );
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
    if (outcome.failure)
      new Notice(t("ui.outline_import_partial", outcome.created.length, outcome.total, outcome.failure));
    if (outcome.failure || state.saveFailed || !written || !request.shallowResearch || !outcome.created.length) return;
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
          researchMode: "research",
          referenceGroups: [],
          visualMode: "off",
          ...request.researchOptions,
          researchDepth: request.researchDepth ?? "fast",
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
                        translate(contentLanguage, "note.aim_initial_clarification") +
                        "\n\n" +
                        answers
                    },
                    { contentLanguage }
                  );
                }
              });
              await this.hydrate();
              void this.planAimFromSelection(node.id);
            },
            this.plugin.settings.language === "en",
            contentLanguage
          ).open();
          return;
        }
        await this.plugin.mutate(async () => {
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          await this.plugin.repo.updateNote(
            node.path,
            { detail: latest.detail + "\n\n<!-- aim-intake-complete -->" },
            { contentLanguage }
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
    this.abortRelevanceGrade();
    const sample = builtInSample(this.plugin.settings.language);
    if (!this.builtIn) this.plugin.closeStaleDetails();
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
      if (
        this.contentEl.contains(document.activeElement) &&
        document.activeElement?.matches("input, textarea, select")
      ) {
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
  private scheduleAimProgressRender(): void {
    if (this.aimProgressRenderTimer !== null) return;
    this.aimProgressRenderTimer = window.setTimeout(() => {
      this.aimProgressRenderTimer = null;
      if (this.closed) return;
      // Like changed(): never interrupt a drag or an open input; try again shortly instead.
      const typing =
        this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select");
      if (this.dragging || typing) this.scheduleAimProgressRender();
      else this.renderPreservingFocus();
    }, 300);
  }
  private stopAimProgress(): void {
    this.aimProgress = null;
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
    return t("ui.aim_stage_with_elapsed_0_1", stage, clock);
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
  private async mapChange(change: (map: MapDocument) => void, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    const path = this.path;
    const disk = await this.plugin.repo.readMap(path);
    const structure = (map: MapDocument): string => JSON.stringify({ ...map, viewport: null });
    if (structure(disk) !== structure(this.map)) {
      const local = clone(this.map);
      this.map = await new Promise<MapDocument>(resolve => new MapConflictModal(this.app, local, disk, resolve).open());
      this.history.clear();
    }
    const before = clone(this.map);
    try {
      change(this.map);
    } catch (error) {
      this.map = before;
      throw error;
    }
    const after = clone(this.map);
    try {
      await this.persist();
    } catch (error) {
      this.map = before;
      this.render();
      throw error;
    }
    const ownership = (map: MapDocument): string =>
      JSON.stringify(map.nodes.map(node => [node.id, node.path, node.parentId]));
    if (rebuildDerivedData && ownership(before) !== ownership(after)) await this.plugin.rebuildDerivedData();
    const restore = async (snapshot: MapDocument): Promise<void> => {
      const previous = clone(this.map!);
      const next = clone(snapshot);
      if (this.map) next.viewport = clone(this.map.viewport);
      await this.plugin.repo.saveMap(path, next);
      this.map = next;
      if (ownership(previous) !== ownership(next)) await this.plugin.rebuildDerivedData();
      await this.hydrate();
    };
    this.history.push({ undo: () => restore(before), redo: () => restore(after) });
    this.render();
  }
  private async restoreLifecycle(snapshot: MapDocument, moves: FileMove[], parked: boolean): Promise<void> {
    const previous = clone(this.map!),
      transitioned: FileMove[] = [];
    try {
      for (const move of moves) {
        const from = parked ? move.activePath : move.parkedPath,
          to = parked ? move.parkedPath : move.activePath;
        await this.plugin.repo.moveExact(from, to);
        transitioned.push(move);
        await this.plugin.repo.setLifecycle(
          to,
          move.topicId,
          parked ? "" : snapshot.id,
          parked ? move.parkedState : "active"
        );
      }
      await this.plugin.repo.saveMap(this.path, clone(snapshot));
      this.map = clone(snapshot);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    } catch (error) {
      try {
        for (const move of transitioned.reverse()) {
          const from = parked ? move.activePath : move.parkedPath,
            to = parked ? move.parkedPath : move.activePath;
          if (this.app.vault.getAbstractFileByPath(to)) await this.plugin.repo.moveExact(to, from);
          await this.plugin.repo.setLifecycle(
            from,
            move.topicId,
            parked ? previous.id : "",
            parked ? "active" : move.parkedState
          );
        }
        await this.plugin.repo.saveMap(this.path, previous);
        this.map = previous;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.topic_state_change_rollback_failed"));
      }
      throw error;
    }
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
      moves: FileMove[] = [];
    try {
      for (const item of removed) {
        const target = await this.plugin.repo.moveUnique(
          item.path,
          this.plugin.repo.topicFolder(this.path, "Unassigned")
        );
        moves.push({ activePath: item.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before);
      const adopted = new Set<string>();
      if (adopterId)
        for (const item of after.nodes)
          if (item.parentId === node.id) {
            item.parentId = adopterId;
            adopted.add(item.id);
            for (const id of descendants(after.nodes, item.id)) adopted.add(id);
          }
      after.nodes = removeNodes(after.nodes, node.id, branch);
      if (adopterId && adopted.size) {
        const adopter = after.nodes.find(item => item.id === adopterId);
        if (adopter) adopter.collapsed = false;
        after.nodes = arrangeNewBranch(after.nodes, adopterId, adopted, this.cardHeightOf);
      }
      this.removeAimReferences(after, ids, before.nodes);
      await this.plugin.repo.saveMap(this.path, after);
      this.map = after;
      this.selected = null;
      this.multiSelected.clear();
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.history.push({
        undo: () => this.restoreLifecycle(before, moves, false),
        redo: () => this.restoreLifecycle(after, moves, true)
      });
      this.render();
    } catch (error) {
      for (const move of [...moves].reverse())
        if (
          this.app.vault.getAbstractFileByPath(move.parkedPath) &&
          !this.app.vault.getAbstractFileByPath(move.activePath)
        )
          await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
      throw error;
    }
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
  private async mergeModel(parentId: string | null): Promise<string> {
    const parent = parentId ? this.map?.nodes.find(node => node.id === parentId) : undefined;
    return resolveMergeModel(
      parent ? (await this.plugin.repo.readNote(parent.path, this.map ?? undefined)).model : undefined,
      this.plugin.settings.cliModel
    );
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
    const model = await this.mergeModel(snapshot.targetId ?? snapshot.parentId);
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
        this.plugin.askModel(context, task.model, this.plugin.settings.cliReasoning, task.controller.signal);
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
  /** Puts moved notes back where they were and restores their lifecycle, newest move first. */
  private async revertMergeMoves(moves: MergeMove[]): Promise<void> {
    for (const move of [...moves].reverse()) {
      if (this.app.vault.getAbstractFileByPath(move.to) && !this.app.vault.getAbstractFileByPath(move.from))
        await this.plugin.repo.moveExact(move.to, move.from);
      await this.plugin.repo.setLifecycle(move.from, move.topicId, move.restoreMapId, move.restoreState);
    }
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
    const model = content?.task.model ?? (await this.mergeModel(check.parentId));
    const created = await repo.createNote(
      title,
      model,
      before,
      mapPath,
      check.parentId ? "inherited" : "workspace",
      content ? undefined : { detail }
    );
    const done: MergeMove[] = [],
      moves: FileMove[] = [];
    const after = clone(before);
    try {
      if (content) {
        const detailTemplate = this.mapDetailTemplate(language);
        await repo.updateNote(
          created.path,
          {
            summary: content.summary,
            detail: canonicalDetail(content.detail, language, detailTemplate),
            visualReferences: visualReferencesMarkdown(content.visualReferences, language),
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
      for (const source of sources) {
        const target = await repo.moveUnique(source.path, repo.topicFolder(mapPath, "Unassigned"));
        done.push({
          from: source.path,
          to: target,
          topicId: before.id,
          restoreMapId: before.id,
          restoreState: "active"
        });
        moves.push({ activePath: source.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const ids = new Set(sources.map(source => source.id)),
        first = sources[0],
        merged: MapNode = { ...created, parentId: check.parentId, x: first.x, y: first.y, collapsed: false },
        adopted = new Set<string>();
      for (const item of after.nodes)
        if (item.parentId !== null && ids.has(item.parentId)) {
          item.parentId = merged.id;
          adopted.add(item.id);
          for (const id of descendants(after.nodes, item.id)) adopted.add(id);
        }
      after.nodes = after.nodes.flatMap(item => (item.id === first.id ? [merged] : ids.has(item.id) ? [] : [item]));
      if (adopted.size) after.nodes = arrangeNewBranch(after.nodes, merged.id, adopted, this.cardHeightOf);
      await repo.saveMap(mapPath, after);
    } catch (error) {
      try {
        await this.revertMergeMoves(done);
        await repo.saveMap(mapPath, before);
        const parked = await repo.moveUnique(created.path, repo.topicFolder(mapPath, "Unassigned"));
        await repo.setLifecycle(parked, before.id, "", "unassigned");
        this.map = before;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.merge_rollback_failed"));
      }
      throw error;
    }
    const state: MergeState = {
      before,
      after,
      newId: created.id,
      newActive: created.path,
      newParked: null,
      sources: moves
    };
    this.map = after;
    if (content && this.mergeTasks.get(mapPath) === content.task) this.mergeTasks.delete(mapPath);
    this.history.push({
      label: t("ui.merge_topics_history"),
      undo: () => this.applyMerge(state, false),
      redo: () => this.applyMerge(state, true)
    });
    this.integrationMode = false;
    this.selected = created.id;
    this.multiSelected.clear();
    try {
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
      const merged = this.map?.nodes.find(item => item.id === created.id);
      if (merged) this.focusNode(merged);
    } catch {
      this.render();
      new Notice(t("ui.merge_saved_refresh_failed"));
    }
  }
  /** The note's exact text, and a verbatim write of it (undo of a merge into a parent restores the original this way). */
  private async readNoteText(path: string): Promise<string> {
    return this.app.vault.read(this.plugin.repo.file(path));
  }
  private async writeNoteText(path: string, text: string): Promise<void> {
    await this.app.vault.process(this.plugin.repo.file(path), () => text);
  }
  private mergeGuardOf(note: Note): MergeGuard {
    return { title: note.title, summary: note.summary, detail: note.detail, status: note.status };
  }
  private sameMergeGuard(a: MergeGuard, b: MergeGuard): boolean {
    return MERGE_GUARD_FIELDS.every(field => JSON.stringify(a[field]) === JSON.stringify(b[field]));
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
    const beforeText = await this.readNoteText(target.path),
      sourceNotes: Note[] = [];
    for (const source of sources) sourceNotes.push(await repo.readNote(source.path, before));
    const guardBefore = this.mergeGuardOf(sourceNotes[0]),
      name = title.trim(),
      sourcePaths = [...new Set([...sourceNotes[0].sourcePaths, ...children.map(child => child.path)])];
    let patch: NotePatch;
    if (content) {
      const references = visualReferencesMarkdown(content.visualReferences, language);
      patch = {
        summary: content.summary,
        detail: canonicalDetail(content.detail, language, detailTemplate),
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
    const done: MergeMove[] = [],
      moves: FileMove[] = [],
      after = clone(before);
    try {
      await repo.updateNote(target.path, patch, { detailTemplate });
      for (const child of children) {
        const parked = await repo.moveUnique(child.path, repo.topicFolder(mapPath, "Unassigned"));
        done.push({
          from: child.path,
          to: parked,
          topicId: before.id,
          restoreMapId: before.id,
          restoreState: "active"
        });
        moves.push({ activePath: child.path, parkedPath: parked, topicId: before.id, parkedState: "unassigned" });
        await repo.setLifecycle(parked, before.id, "", "unassigned");
      }
      const ids = new Set(children.map(child => child.id)),
        adopted = new Set<string>();
      for (const item of after.nodes)
        if (item.parentId !== null && ids.has(item.parentId)) {
          item.parentId = target.id;
          adopted.add(item.id);
          for (const id of descendants(after.nodes, item.id)) adopted.add(id);
        }
      after.nodes = after.nodes.filter(item => !ids.has(item.id));
      if (adopted.size) after.nodes = arrangeNewBranch(after.nodes, target.id, adopted, this.cardHeightOf);
      await repo.saveMap(mapPath, after);
    } catch (error) {
      try {
        await this.revertMergeMoves(done);
        await this.writeNoteText(target.path, beforeText);
        await repo.saveMap(mapPath, before);
        this.map = before;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.merge_rollback_failed"));
      }
      throw error;
    }
    const state: ParentMergeState = {
      before,
      after,
      targetPath: target.path,
      beforeText,
      patch,
      detailTemplate,
      guardBefore,
      guardAfter: this.mergeGuardOf(await repo.readNote(target.path)),
      sources: moves
    };
    this.map = after;
    if (content && this.mergeTasks.get(mapPath) === content.task) this.mergeTasks.delete(mapPath);
    this.history.push({
      label: t("ui.merge_topics_history"),
      undo: () => this.applyParentMerge(state, false),
      redo: () => this.applyParentMerge(state, true)
    });
    this.integrationMode = false;
    this.selected = target.id;
    this.multiSelected.clear();
    try {
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
      const merged = this.map?.nodes.find(item => item.id === target.id);
      if (merged) this.focusNode(merged);
    } catch {
      this.render();
      new Notice(t("ui.merge_saved_refresh_failed"));
    }
  }
  /**
   * Undo (`merged` false) or redo (`merged` true) of a merge into a parent. The parent's visible content must still be
   * what the merge left (or what it replaced) before any file moves; undo writes the original text back verbatim.
   */
  private async applyParentMerge(state: ParentMergeState, merged: boolean): Promise<void> {
    const repo = this.plugin.repo,
      previous = clone(this.map!),
      mapPath = this.path,
      topicId = state.before.id,
      done: MergeMove[] = [];
    const latest = this.mergeGuardOf(await repo.readNote(state.targetPath));
    if (!this.sameMergeGuard(latest, merged ? state.guardBefore : state.guardAfter))
      throw new Error(t("ui.merge_target_changed"));
    const priorText = await this.readNoteText(state.targetPath);
    try {
      if (merged) await repo.updateNote(state.targetPath, state.patch, { detailTemplate: state.detailTemplate });
      for (const move of state.sources) {
        const from = merged ? move.activePath : move.parkedPath,
          to = merged ? move.parkedPath : move.activePath;
        await repo.moveExact(from, to);
        done.push({
          from,
          to,
          topicId,
          restoreMapId: merged ? topicId : "",
          restoreState: merged ? "active" : "unassigned"
        });
        await repo.setLifecycle(to, topicId, merged ? "" : topicId, merged ? "unassigned" : "active");
      }
      if (!merged) await this.writeNoteText(state.targetPath, state.beforeText);
      const next = clone(merged ? state.after : state.before);
      next.viewport = clone(previous.viewport);
      await repo.saveMap(mapPath, next);
      this.map = next;
      if (this.selected && !next.nodes.some(item => item.id === this.selected)) this.selected = null;
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    } catch (error) {
      try {
        await this.revertMergeMoves(done);
        await this.writeNoteText(state.targetPath, priorText);
        await repo.saveMap(mapPath, previous);
        this.map = previous;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.merge_rollback_failed"));
      }
      throw error;
    }
  }
  /** Undo (`merged` false) or redo (`merged` true) of a merge: the same notes move between the same two paths. */
  private async applyMerge(state: MergeState, merged: boolean): Promise<void> {
    const previous = clone(this.map!),
      repo = this.plugin.repo,
      mapPath = this.path,
      topicId = state.before.id,
      done: MergeMove[] = [];
    const parkNew = async (): Promise<void> => {
      const target = state.newParked
        ? (await repo.moveExact(state.newActive, state.newParked), state.newParked)
        : await repo.moveUnique(state.newActive, repo.topicFolder(mapPath, "Unassigned"));
      state.newParked = target;
      done.push({ from: state.newActive, to: target, topicId, restoreMapId: topicId, restoreState: "active" });
      await repo.setLifecycle(target, topicId, "", "unassigned");
    };
    const unparkNew = async (): Promise<void> => {
      await repo.moveExact(state.newParked!, state.newActive);
      done.push({ from: state.newParked!, to: state.newActive, topicId, restoreMapId: "", restoreState: "unassigned" });
      await repo.setLifecycle(state.newActive, topicId, topicId, "active");
    };
    const parkSources = async (): Promise<void> => {
      for (const move of state.sources) {
        await repo.moveExact(move.activePath, move.parkedPath);
        done.push({
          from: move.activePath,
          to: move.parkedPath,
          topicId,
          restoreMapId: topicId,
          restoreState: "active"
        });
        await repo.setLifecycle(move.parkedPath, topicId, "", "unassigned");
      }
    };
    const unparkSources = async (): Promise<void> => {
      for (const move of state.sources) {
        await repo.moveExact(move.parkedPath, move.activePath);
        done.push({
          from: move.parkedPath,
          to: move.activePath,
          topicId,
          restoreMapId: "",
          restoreState: "unassigned"
        });
        await repo.setLifecycle(move.activePath, topicId, topicId, "active");
      }
    };
    try {
      if (merged) {
        await parkSources();
        await unparkNew();
      } else {
        await parkNew();
        await unparkSources();
      }
      const next = clone(merged ? state.after : state.before);
      next.viewport = clone(previous.viewport);
      await repo.saveMap(mapPath, next);
      this.map = next;
      if (this.selected && !next.nodes.some(item => item.id === this.selected)) this.selected = null;
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    } catch (error) {
      try {
        await this.revertMergeMoves(done);
        await repo.saveMap(mapPath, previous);
        this.map = previous;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.merge_rollback_failed"));
      }
      throw error;
    }
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
      moves: FileMove[] = [];
    try {
      for (const node of removed) {
        const target = await this.plugin.repo.moveUnique(
          node.path,
          this.plugin.repo.topicFolder(this.path, "Unassigned")
        );
        moves.push({ activePath: node.path, parkedPath: target, topicId: before.id, parkedState: "unassigned" });
        await this.plugin.repo.setLifecycle(target, before.id, "", "unassigned");
      }
      const after = clone(before);
      after.nodes = after.nodes.filter(node => !ids.has(node.id));
      this.removeAimReferences(after, ids, before.nodes);
      await this.plugin.repo.saveMap(this.path, after);
      this.map = after;
      this.selected = null;
      this.multiSelected.clear();
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.history.push({
        undo: () => this.restoreLifecycle(before, moves, false),
        redo: () => this.restoreLifecycle(after, moves, true)
      });
      this.render();
    } catch (error) {
      try {
        for (const move of [...moves].reverse()) {
          if (
            this.app.vault.getAbstractFileByPath(move.parkedPath) &&
            !this.app.vault.getAbstractFileByPath(move.activePath)
          )
            await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
          if (this.app.vault.getAbstractFileByPath(move.activePath))
            await this.plugin.repo.setLifecycle(move.activePath, move.topicId, before.id, "active");
        }
        await this.plugin.repo.saveMap(this.path, before);
        this.map = before;
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.batch_remove_rollback_failed"));
      }
      throw error;
    }
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
      target => this.enqueue(() => (copyNodes ? this.copySelected(target) : this.moveSelected(target)))
    ).open();
  }
  private async moveSelected(target: MapNode): Promise<void> {
    const roots = this.selectedRoots();
    if (!this.mergeUnlocked([target.id, ...roots.map(root => root.id)])) return;
    this.assertAimReferencesRemain(this.map!, new Set(roots.map(root => root.id)), true);
    await this.mapChange(map => {
      let offset = 0;
      for (const root of roots) {
        if (!canParent(map.nodes, root.id, target.id)) throw new Error(t("ui.circular_links_are_not_allowed"));
        const node = map.nodes.find(item => item.id === root.id)!;
        node.parentId = target.id;
        node.x = target.x + 340;
        node.y = target.y + offset++ * 220;
      }
      map.nodes.find(node => node.id === target.id)!.collapsed = false;
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
    if (!this.map) return;
    const roots = this.selectedRoots(),
      before = clone(this.map);
    if (!this.mergeUnlocked([target.id, ...roots.flatMap(root => [root.id, ...descendants(before.nodes, root.id)])]))
      return;
    const copies: MapNode[] = [],
      replacement = new Map<string, string>();
    try {
      for (const root of roots) {
        const branch: MapNode[] = [];
        const append = (node: MapNode): void => {
          branch.push(node);
          for (const child of before.nodes.filter(item => item.parentId === node.id)) append(child);
        };
        append(root);
        for (const original of branch) {
          const copy = await this.plugin.repo.duplicateNote(original.path, before, this.path);
          replacement.set(original.id, copy.id);
          copy.parentId = original.id === root.id ? target.id : (replacement.get(original.parentId!) ?? target.id);
          copy.x = target.x + 340 + (original.x - root.x);
          copy.y = target.y + roots.indexOf(root) * 220 + (original.y - root.y);
          copies.push(copy);
        }
      }
      const after = clone(before);
      after.nodes.push(...copies);
      after.nodes.find(node => node.id === target.id)!.collapsed = false;
      await this.plugin.repo.saveMap(this.path, after);
      this.map = after;
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      const moves: FileMove[] = [];
      this.history.push({
        undo: async () => {
          moves.length = 0;
          try {
            for (const copy of copies) {
              const parkedPath = await this.plugin.repo.moveUnique(
                copy.path,
                this.plugin.repo.topicFolder(this.path, "Unassigned")
              );
              moves.push({ activePath: copy.path, parkedPath, topicId: before.id, parkedState: "unassigned" });
              await this.plugin.repo.setLifecycle(parkedPath, before.id, "", "unassigned");
            }
            await this.plugin.repo.saveMap(this.path, before);
            this.map = clone(before);
            await this.plugin.rebuildDerivedData();
            await this.hydrate();
            this.render();
          } catch (error) {
            try {
              for (const move of [...moves].reverse()) {
                if (this.app.vault.getAbstractFileByPath(move.parkedPath))
                  await this.plugin.repo.moveExact(move.parkedPath, move.activePath);
                await this.plugin.repo.setLifecycle(move.activePath, before.id, before.id, "active");
              }
              await this.plugin.repo.saveMap(this.path, after);
              this.map = clone(after);
              await this.plugin.rebuildDerivedData();
              await this.hydrate();
              this.render();
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], t("error.copy_rollback_restore_failed"));
            }
            throw error;
          }
        },
        redo: () => this.restoreLifecycle(after, moves, false)
      });
      this.multiSelected.clear();
      this.render();
    } catch (error) {
      try {
        await this.plugin.repo.saveMap(this.path, before);
        this.map = before;
        for (const copy of copies) {
          if (!this.app.vault.getAbstractFileByPath(copy.path)) continue;
          const parkedPath = await this.plugin.repo.moveUnique(
            copy.path,
            this.plugin.repo.topicFolder(this.path, "Unassigned")
          );
          await this.plugin.repo.setLifecycle(parkedPath, before.id, "", "unassigned");
        }
        await this.plugin.rebuildDerivedData();
        await this.hydrate();
        this.render();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], t("error.batch_copy_rollback_failed"));
      }
      throw error;
    }
  }
  private async claimToCurrent(file: TFile): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map),
      previous = await this.plugin.repo.readNote(file.path, this.map ?? undefined),
      original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes"));
    await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const node: MapNode = {
      id: crypto.randomUUID(),
      path: target,
      parentId: null,
      x: 80,
      y: Math.max(-100, ...this.map.nodes.map(item => item.y)) + 240,
      collapsed: false
    };
    const after = clone(before);
    after.nodes.push(node);
    await this.plugin.repo.saveMap(this.path, after);
    this.map = after;
    this.selected = node.id;
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    const undo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(this.path, before);
      this.map = clone(before);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    const redo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, after.id, after.id, "active");
      await this.plugin.repo.saveMap(this.path, after);
      this.map = clone(after);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
    this.focusNode(node);
  }
  private async relinkMissingNode(node: MapNode, file: TFile): Promise<void> {
    if (!this.map) return;
    const before = clone(this.map),
      previous = await this.plugin.repo.readNote(file.path, this.map ?? undefined),
      original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, "Notes"));
    await this.plugin.repo.setLifecycle(target, this.map.id, this.map.id, "active");
    const after = clone(before),
      replacement = after.nodes.find(item => item.id === node.id);
    if (!replacement) throw new Error(t("ui.the_node_to_relink_was_not_found"));
    rebaseMapNotePaths(after, moveNotePath(replacement.path, target));
    await this.plugin.repo.saveMap(this.path, after);
    this.map = after;
    await this.plugin.rebuildDerivedData();
    await this.hydrate();
    const undo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(this.path, before);
      this.map = clone(before);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    const redo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, after.id, after.id, "active");
      await this.plugin.repo.saveMap(this.path, after);
      this.map = clone(after);
      await this.plugin.rebuildDerivedData();
      await this.hydrate();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  private async parkFile(
    file: TFile,
    collection: "Unassigned" | "Archive",
    state: "unassigned" | "archived"
  ): Promise<void> {
    if (!this.map) return;
    const before = await this.plugin.repo.readNote(file.path, this.map ?? undefined),
      original = file.path;
    const target = await this.plugin.repo.moveUnique(original, this.plugin.repo.topicFolder(this.path, collection));
    await this.plugin.repo.setLifecycle(target, this.map.id, "", state);
    await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, this.map!.id, "", state);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  private async transferToTopic(file: TFile, topic: TopicInfo): Promise<void> {
    const before = await this.plugin.repo.readNote(file.path, this.map ?? undefined),
      original = file.path,
      folder = `${topic.root}/Unassigned`;
    const target = await this.plugin.repo.moveUnique(original, folder);
    await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned");
    await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, before.topicId, before.mapId, before.topicState);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, topic.id, "", "unassigned");
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  private async transferAndAdd(file: TFile, topic: TopicInfo): Promise<void> {
    const previous = await this.plugin.repo.readNote(file.path, this.map ?? undefined),
      original = file.path,
      before = await this.plugin.repo.readMap(topic.mapPath);
    const target = await this.plugin.repo.moveUnique(original, `${topic.root}/Notes`);
    await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active");
    const node: MapNode = {
      id: crypto.randomUUID(),
      path: target,
      parentId: null,
      x: 80,
      y: Math.max(-100, ...before.nodes.map(item => item.y)) + 240,
      collapsed: false
    };
    const after = clone(before);
    after.nodes.push(node);
    await this.plugin.repo.saveMap(topic.mapPath, after);
    await this.plugin.rebuildDerivedData();
    const undo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(target, original);
      await this.plugin.repo.setLifecycle(original, previous.topicId, previous.mapId, previous.topicState);
      await this.plugin.repo.saveMap(topic.mapPath, before);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    const redo = async (): Promise<void> => {
      await this.plugin.repo.moveExact(original, target);
      await this.plugin.repo.setLifecycle(target, topic.id, topic.id, "active");
      await this.plugin.repo.saveMap(topic.mapPath, after);
      await this.plugin.rebuildDerivedData();
      this.render();
    };
    this.history.push({ undo, redo });
    this.render();
  }
  private async noteChange(node: MapNode, patch: NotePatch): Promise<void> {
    const current = await this.plugin.repo.readNote(node.path, this.map ?? undefined),
      before: NotePatch = {};
    for (const key of Object.keys(patch) as (keyof Note)[]) (before as Record<string, unknown>)[key] = current[key];
    if (Object.keys(patch).every(key => current[key as keyof Note] === patch[key as keyof Note])) return;
    await this.plugin.repo.updateNote(node.path, patch);
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
      undo: () => this.plugin.repo.updateNote(node.path, before),
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
      note.researchDepth,
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
    language: UiLanguage;
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
          { detail: canonicalDetail(charted, job.language, job.template) },
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
    }
    const before = JSON.stringify(Array.from(this.notes));
    await this.hydrate();
    if (structureChanged || before !== JSON.stringify(Array.from(this.notes))) {
      const editing =
        this.contentEl.contains(document.activeElement) && document.activeElement?.matches("input, textarea, select");
      if ((!editing || structureChanged) && !this.dragging) this.render();
      else for (const node of this.map.nodes) this.refreshCard(node);
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
    if (focusedCard && this.contentEl.contains(focusedCard)) this.focusNodeId ??= focusedCard.dataset.nodeId ?? null;
    const restoreRelevanceFocus = this.keepRelevanceBarFocus();
    this.contentEl.empty();
    const toolbar = this.contentEl.createDiv("vam-toolbar");
    const switcher = toolbar.createEl("button", { cls: "vam-map-switcher" });
    switcher.setAttr("aria-label", t("ui.switch_mind_map"));
    switcher.createSpan({ text: this.map?.title ?? "Visual Agent Map", cls: "vam-map-title" });
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
      this.button(actions, t("ui.create_an_empty_mind_map"), () =>
        new NameModal(this.app, t("ui.new_mind_map"), t("ui.new_mind_map_from_sample"), title =>
          this.enqueue(async () => this.openMapInMutation(await this.plugin.repo.createMap(title)))
        ).open()
      );
      if (!this.plugin.settings.models.trim())
        this.button(actions, t("ui.check_codex"), () => this.enqueue(() => this.plugin.recheckCodex()));
    }
    if (!this.builtIn && !this.map.aim) this.renderMultiResearchStatus(this.contentEl);
    if (!this.builtIn && !this.map.aim) this.renderRelevanceStatus(this.contentEl);
    if (!this.builtIn && !this.map.aim) this.renderBackgroundBars(this.contentEl);
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
    this.viewportEl = workspace.createDiv("vam-viewport");
    if (this.integrationMode) this.viewportEl.addClass("is-selecting");
    // Canvas controls float over the map instead of stacking a second toolbar above it.
    const overlay = workspace.createDiv("vam-canvas-overlay");
    if (tools.childElementCount) overlay.appendChild(tools);
    else tools.remove();
    if (this.relevancePanelEl) this.placeRelevancePanel(this.relevancePanelEl);
    // The gesture hint goes away once the user has panned or zoomed; select mode always explains its own gestures.
    this.hintEl =
      this.integrationMode || !this.plugin.settings.canvasHintSeen
        ? overlay.createSpan({
            cls: "vam-hint vam-canvas-hint",
            text: t(
              this.integrationMode
                ? "ui.drag_to_select_topics_hint"
                : "ui.drag_empty_space_to_pan_scroll_to_zoom_click_a_node_to_open"
            )
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
    if (this.integrationMode) this.selectionBarEl = this.renderSelectionBar(workspace);
    this.tabStopId = this.defaultTabStop(shown);
    this.renderingCard = true;
    try {
      for (const node of shown) this.renderNode(node);
    } finally {
      this.renderingCard = false;
    }
    this.renderAimPendingCards(shown);
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
    if (!this.map.nodes.length) {
      const emptyMap = this.viewportEl.createDiv("vam-empty");
      emptyMap.createSpan({
        text: t(
          this.map.aim ? "ui.aim_empty_map_hint" : "ui.this_mind_map_has_no_topics_click_topic_to_create_the_first"
        )
      });
      if (!this.map.aim) this.button(emptyMap, t("ui.topic"), () => this.enqueue(() => this.addNode(null)));
    }
    this.setupPan();
    this.applyInitialViewport();
    this.transform();
    this.drawEdges();
    if (this.builtIn && this.selected) {
      const node = this.map.nodes.find(n => n.id === this.selected);
      if (node) this.renderInspector(workspace, node);
    }
    restoreRelevanceFocus();
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
    card.tabIndex = node.id === this.tabStopId ? 0 : -1;
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
    } else if (!node.aimKind || active || queued || !note || note.status !== "completed") {
      const statusText = merging
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
      if (!note || note.status !== "completed" || active || queued) {
        const chip = header.createSpan({
          cls: `vam-status vam-status-${active ? "running" : queued ? "queued" : (note?.status ?? "error")}`,
          text: statusText
        });
        if (active) chip.setAttr("role", "status");
      }
      if (note) this.labelCard(card, t("ui.topic_card_label_0_1", note.title, statusText));
    }
    // Offline relevance grading: mind maps only, and only a valid tier shows anything. Side topics fade (see styles.css)
    // but are never hidden, moved or collapsed.
    const relevance = !node.aimKind && !this.map?.aim && !this.builtIn ? note?.relevance : undefined;
    if (relevance) {
      const tierLabel = t(RELEVANCE_LABEL[relevance.tier]);
      card.dataset.relevance = relevance.tier;
      const reasonText = relevance.manual ? t("ui.relevance_manual_reason") : relevance.reason;
      setTooltip(
        renderRelevanceTagButton(
          header,
          relevance.tier,
          tierLabel,
          t("ui.relevance_tag_label_0", tierLabel),
          button => this.openRelevanceMenu(node, relevance.tier, button),
          this.plugin.relevanceGrades.get(this.path)?.status === "running"
        ),
        reasonText
      );
      card.setAttr("aria-description", t("ui.relevance_description_0_1", tierLabel, reasonText));
      const named = cardLabels.get(card)?.textContent;
      if (named) this.labelCard(card, t("ui.topic_card_label_0_1", named, tierLabel));
    }
    // Failure reasons are shown on the card, not only in a hover tooltip.
    const errorDetails: string[] = [];
    if (note?.detailFormatIssues?.length) {
      const issue = header.createSpan({ cls: "vam-status vam-status-error", text: t("ui.detail_format_unmet") });
      issue.setAttr("title", note.detailFormatIssues.join("\n"));
      errorDetails.push(...note.detailFormatIssues);
    }
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
    const pendingCount = this.plugin.pendingSuggestions.get(node.path)?.length ?? 0;
    if (pendingCount && !this.builtIn && !this.integrationMode && !this.map?.aim)
      this.button(header, t("ui.view_0_expansion_suggestions", pendingCount), () =>
        this.openNodePanel(node, "proposals")
      ).addClass("vam-badge-new");
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
              map.nodes = arrangeMap(map.nodes, supersededAimNodeIds(map), this.cardHeightOf);
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
    const title = card.createEl("h3", { text: note?.title ?? node.path, cls: "vam-card-title" });
    title.setAttr("title", note?.title ?? node.path);
    // An unresearched topic's placeholder summary repeats its status, so the frontier card stays quiet.
    if (!note || !isPlaceholder(note.summary))
      card.createEl("p", {
        cls: "vam-card-summary",
        text: note?.summary ?? t("ui.the_file_was_moved_or_deleted_you_can_remove_this_node_from")
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
      if (event.key === "F2" && note && !this.builtIn && !this.integrationMode && !this.map?.aim) {
        event.preventDefault();
        new NameModal(this.app, t("ui.new_topic_name"), note.title, title =>
          this.enqueue(() => this.noteChange(node, { title }))
        ).open();
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
    const toolButtons = (): HTMLButtonElement[] => Array.from(card.querySelectorAll<HTMLButtonElement>("button"));
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
  }
  /** What the canvas draws: visible nodes minus interim AIM results already superseded by their run's conclusion. */
  private canvasNodes(): MapNode[] {
    if (!this.map) return [];
    const superseded = supersededAimNodeIds(this.map);
    const shown = visibleNodes(this.map.nodes);
    const nodes = superseded.size ? shown.filter(node => !superseded.has(node.id)) : shown;
    // A view only: these copies carry display positions and must never be written back to the map.
    return this.relevanceSortOn()
      ? relevanceDisplayNodes(nodes, id => this.notes.get(id)?.relevance?.tier, superseded)
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
    if (key === "ArrowLeft") return shown.find(item => item.id === node.parentId);
    if (key === "ArrowRight") return shown.filter(item => item.parentId === node.id).sort(byY)[0];
    const siblings = shown.filter(item => (item.parentId ?? null) === (node.parentId ?? null)).sort(byY);
    const index = siblings.findIndex(item => item.id === node.id);
    return siblings[index + (key === "ArrowUp" ? -1 : 1)];
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
  }
  /**
   * Moves the selection without rebuilding the map: only the previous and next cards, the changed multi-select
   * cards and the two tab stops are repainted, and the selection bar is refreshed in selection mode.
   */
  applySelectionState(prevId: string | null, nextId: string | null, touched: Iterable<string> = []): void {
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
  /** Names a card for assistive tech without Obsidian showing `aria-label` as a hover tooltip beside the preview. */
  private labelCard(card: HTMLElement, text: string): void {
    let label = cardLabels.get(card);
    if (!label) {
      label = card.createSpan({ cls: "vam-card-label" });
      label.id = `vam-card-label-${++cardLabelSequence}`;
      cardLabels.set(card, label);
    }
    label.textContent = text;
    card.setAttr("aria-labelledby", label.id);
  }
  /**
   * Brings an outline topic into view: expands collapsed ancestors, centers the card and selects it.
   * Multi-select keeps its selection; the outline only moves the camera there. False when the map lacks the topic.
   */
  hasPath(path: string): boolean {
    return !!this.map?.nodes.some(item => item.path === path);
  }
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
    const workspace = this.contentEl.querySelector<HTMLElement>(".vam-workspace");
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
    const content = preview.createDiv("vam-hover-markdown");
    const path = this.map?.nodes.find(node => node.id === card.dataset.nodeId)?.path ?? "";
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
  private refreshCard(node: MapNode): void {
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
    this.drawEdges();
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
      completed: kind => {
        if (!node || this.closed || this.path !== mapPath) return;
        const title = this.notes.get(node.id)?.title ?? node.path;
        if (kind === "research")
          backgroundResultNotice(t("ui.background_research_done_0", title), {
            label: t("ui.background_view"),
            open: () => this.openDetails(node)
          });
        else {
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
        note.researchDepth,
        this.map?.nodes.filter(item => item.parentId === node.id).length ?? 0,
        this.plugin.pendingSuggestions.get(node.path)?.length ?? 0,
        this.plugin,
        async (options, focus, done, failed, accepted) => {
          const latest = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          const task = researchTopicTask(this.plugin.settings.language, latest.title);
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
              visualMode: options.visualMode
            },
            accepted
          );
        },
        (options, direction, found, failed, accepted) =>
          this.proposeChildren(node, options, direction, found, failed, accepted),
        (options, direction, failed, accepted, observer) =>
          this.startSynthesis(node, options, direction, failed, accepted, observer),
        {
          model: note.model,
          modelSource: note.modelSource,
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
          structureReview: this.structureReviewEntry(node),
          sources,
          templates: this.templateChoices(),
          tones: this.toneChoices(),
          currentTone: this.toneLabelFor(note),
          currentStyle: this.currentStyleLabel(this.resolveTopicTemplate(note).template.id, this.effectiveToneId(note)),
          currentSummary: note.summary,
          // Only a label: a missing topic template is reported at the next AI update, not when the dialog opens.
          currentTemplate: this.resolveTopicTemplate(note).template.name,
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
        panel.createEl("h3", { text: note.title });
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
    const relationship = panel.createDiv("vam-inspector-section");
    relationship.createEl("strong", { text: t("ui.parent_topic"), cls: "vam-topic-tree-heading" });
    let chosenParent = node.parentId ?? "";
    let describe = (): void => {};
    const parentTree = renderTopicTree(relationship, {
      nodes: this.map!.nodes,
      title: candidate => this.notes.get(candidate.id)?.title ?? candidate.path,
      label: t("ui.parent_topic_link"),
      selectable: candidate => canParent(this.map!.nodes, node.id, candidate.id),
      rootChoice: t("ui.no_parent_root_topic"),
      value: chosenParent,
      onChoose: id => {
        chosenParent = id;
        parentTree.select(id);
        describe();
      }
    });
    relationship.createEl("p", {
      cls: "vam-hint",
      text: t("ui.changing_the_parent_affects_context_for_the_next_ai_task_the")
    });
    // Choosing a parent is a draft; nothing moves until Apply, and the dialog says what will change.
    const actions = (host ?? panel).createDiv("vam-next-actions");
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
    const apply = actions.createEl("button", { text: t("ui.apply_parent"), cls: "mod-cta" });
    describe = (): void => {
      const parentId = chosenParent || null;
      const changed = parentId !== (node.parentId ?? null);
      apply.disabled = !changed;
      status.setText(
        !changed
          ? ""
          : parentId
            ? t("ui.will_move_under_0", this.notes.get(parentId)?.title ?? "")
            : t("ui.will_become_root_topic")
      );
    };
    describe();
    apply.addEventListener("click", () => {
      const parentId = chosenParent || null;
      if (!this.mergeUnlocked(parentId ? [node.id, parentId] : [node.id])) return;
      close?.();
      this.enqueue(async () => {
        if (!this.mergeUnlocked(parentId ? [node.id, parentId] : [node.id])) return;
        await this.mapChange(map => {
          if (!canParent(map.nodes, node.id, parentId)) throw new Error(t("ui.circular_links_are_not_allowed"));
          map.nodes.find(n => n.id === node.id)!.parentId = parentId;
        });
      });
    });
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
                  researchMode: "research" as const,
                  researchDepth: "fast" as const,
                  referenceGroups: [],
                  visualMode: "off" as const
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
            await this.startShallowResearch(node, createdNodes, this.shallowChildOptions(researchOptions));
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
  private async addNode(parentNode: MapNode | null, suggestedTitle?: string, rebuildDerivedData = true): Promise<void> {
    if (!this.map) return;
    // The caller may hold a display copy (sorted by relevance); saved coordinates must come from the real node.
    const parent = (parentNode && this.map.nodes.find(item => item.id === parentNode.id)) || parentNode;
    if (!suggestedTitle?.trim()) {
      new NameModal(this.app, parent ? t("ui.new_subtopic") : t("ui.my_core_topic"), "", title =>
        this.enqueue(() => this.addNode(parent, title))
      ).open();
      return;
    }
    const model = inheritModel(
      parent ? (await this.plugin.repo.readNote(parent.path, this.map ?? undefined)).model : undefined,
      this.plugin.settings.cliModel
    );
    if (!isManagedMapPath(this.plugin.settings, this.path)) {
      new Notice(t("ui.legacy_map_view_only"));
      return;
    }
    const node = await this.plugin.repo.createNote(
      suggestedTitle?.trim() || (parent ? t("ui.new_subtopic") : t("ui.my_core_topic")),
      model,
      this.map,
      this.path,
      parent ? "inherited" : "workspace"
    );
    if (parent) {
      const parentNote = await this.plugin.repo.readNote(parent.path, this.map ?? undefined);
      await this.plugin.repo.updateNote(node.path, { reasoning: parentNote.reasoning });
    }
    node.parentId = parent?.id ?? null;
    node.x = parent ? parent.x + 340 : 80;
    const siblings = this.map.nodes.filter(n => n.parentId === node.parentId);
    node.y = siblings.length ? Math.max(...siblings.map(n => n.y)) + 220 : (parent?.y ?? 80);
    this.notes.set(
      node.id,
      await this.plugin.repo.readNote(node.path, { ...this.map, nodes: [...this.map.nodes, node] })
    );
    this.selected = node.id;
    await this.mapChange(map => {
      map.nodes.push(node);
      if (parent) map.nodes.find(n => n.id === parent.id)!.collapsed = false;
    }, rebuildDerivedData);
    if (this.map) this.map.viewport.zoom = Math.max(this.map.viewport.zoom, 0.7);
    this.focusNode(node);
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
          await this.startShallowResearch(parent, createdNodes, this.shallowChildOptions(researchOptions));
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
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const outputLanguage = options?.outputLanguage ?? this.plugin.settings.language;
      const existing =
        this.map?.nodes
          .filter(item => item.parentId === parent.id)
          .map(item => {
            const child = this.notes.get(item.id);
            return `- ${child?.title || item.path}: ${child?.summary || noSummaryYet(outputLanguage)}`;
          })
          .join("\n") || inLanguage(NONE, outputLanguage);
      const task = expansionTask(outputLanguage, existing, direction);
      const result = await this.plugin.askModel(
        withThinkingOrigin(
          {
            title: note.title,
            summary: note.summary,
            rules: "",
            detail: note.detail,
            task: [task, options?.requirements].filter(Boolean).join("\n\n"),
            ancestors: await this.ancestorContext(parent),
            referenceGroups: options?.referenceGroups,
            outputLanguage: options?.outputLanguage,
            ...this.toneField(note, options),
            mode: "decompose",
            researchMode: options?.researchMode ?? "research",
            researchDepth: options?.researchDepth ?? note.researchDepth,
            visualMode: "off"
          },
          note
        ),
        note.model,
        note.reasoning,
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
          await this.startShallowResearch(parent, createdNodes, this.shallowChildOptions(researchOptions));
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
    const createdByTitle = new Map<string, MapNode>(),
      newNodes: MapNode[] = [];
    const contributionTemplate = this.mapDetailTemplate(this.plugin.settings.language, detailTemplateId);
    try {
      for (const item of items) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const owner = item.parentTitle ? createdByTitle.get(item.parentTitle) : parent;
        if (!owner) throw new Error(t("ui.select_the_parent_topic_before_its_child"));
        await this.addNode(owner, item.title, false);
        created++;
        const child = this.map.nodes.at(-1)!;
        newNodes.push(child);
        createdByTitle.set(item.title, child);
        await this.noteChange(child, {
          prompt: item.task,
          detail: researchOptions
            ? ""
            : item.contribution
              ? canonicalDetail(item.contribution, this.plugin.settings.language, contributionTemplate)
              : "",
          ...(researchOptions
            ? {
                researchMode: "research" as const,
                researchDepth: "fast" as const,
                visualMode: researchOptions.visualMode
              }
            : {}),
          ...(detailTemplateId ? { detailTemplateId } : {})
        });
      }
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (newNodes.length)
        await this.mapChange(map => {
          map.nodes = arrangeNewBranch(map.nodes, parent.id, new Set(newNodes.map(node => node.id)), this.cardHeightOf);
        }, false);
      if (created) await this.plugin.rebuildDerivedData();
      return newNodes;
    } catch (error) {
      if (created) {
        await this.plugin.rebuildDerivedData();
        throw new PartialChildBatchError(
          t("ui.some_subtopics_were_created_reopen_this_window_and_check_the") +
            ` ${error instanceof Error ? error.message : String(error)}`
        );
      }
      throw error;
    }
  }
  /**
   * The options of the quick research that follows AI expansion: no web or image search unless the dialog's checkbox
   * is on. The decomposition itself and the notes' stored research settings are not affected.
   */
  private shallowChildOptions(options: TaskOptions): TaskOptions {
    return options.shallowWebSearch ? options : { ...options, researchMode: "local", visualMode: "off" };
  }
  private startShallowResearch(parent: MapNode, children: MapNode[], options: TaskOptions): Promise<void> {
    const signal = options.signal;
    const pendingOptions = this.researchChoices(options);
    this.plugin.quickExpandPending.add(parent.path);
    return this.plugin.expansionCoordinator.start(
      parent.path,
      children,
      (child, batchSignal, accepted) => this.researchChild(child, batchSignal, accepted, pendingOptions),
      () => {
        const state = this.plugin.expansionBatches.get(parent.path);
        if (state?.status === "running") this.plugin.quickExpandPending.add(parent.path);
        else this.plugin.quickExpandPending.delete(parent.path);
        this.render();
      },
      signal
    );
  }
  private async researchChild(
    child: MapNode,
    batchSignal: AbortSignal,
    accepted: () => void,
    choices: TaskOptions
  ): Promise<void> {
    const detailTemplate = await this.detailTemplateFor(child, choices.detailTemplateId, choices.toneId);
    const note = await this.plugin.repo.readNote(child.path, this.map ?? undefined);
    const outputLanguage =
      choices.outputLanguage ?? chooseAimContentLanguage(this.plugin.settings.language, note.title);
    let started = false;
    let failure: string | undefined;
    const handle = await this.runAgent(
      child,
      undefined,
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
        task: [note.prompt || researchTopicTask(outputLanguage, note.title), choices.requirements]
          .filter(Boolean)
          .join("\n\n")
      },
      () => {
        started = true;
        accepted();
      }
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
    const names = [...this.multiSelected].map(id => this.notes.get(id)?.title).filter((name): name is string => !!name);
    new MultiResearchModal(
      this.app,
      names,
      this.modelChoices(),
      this.templateChoices(),
      request => void this.startMultiResearch(request, retryBatchKey),
      this.toneChoices(),
      (selected, refreshed) =>
        new PromptPresetsModal(this.app, this.plugin, "tone", () => refreshed(this.toneChoices()), selected).open(),
      this.fieldLinks()
    ).open();
  }
  stopMultiResearch(): void {
    this.plugin.expansionCoordinator.stop(this.multiResearchKey());
  }
  async startMultiResearch(request: MultiResearchRequest, retryBatchKey?: string): Promise<void> {
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
      await this.plugin.confirmAiUsage(request.model ?? this.plugin.settings.cliModel, async () => {
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
        if (request.model)
          for (const node of nodes)
            await this.plugin.repo.updateNote(node.path, { model: request.model, modelSource: "manual" });
        // The batch runs in the background: leave selection mode so the selection bar gets out of the way.
        this.integrationMode = false;
        this.multiSelected.clear();
        if (!this.closed) this.render();
        const choices: TaskOptions = {
          researchMode: request.researchMode,
          researchDepth: request.researchDepth,
          visualMode: request.imageSearch ? "auto" : "off",
          referenceGroups: [],
          requirements: request.requirements,
          ...(request.detailTemplateId ? { detailTemplateId: request.detailTemplateId } : {}),
          ...(request.toneId ? { toneId: request.toneId } : {})
        };
        // A retry replaces the failure state of the batch it came from (a running batch is never touched).
        if (retryBatchKey && this.plugin.expansionBatches.get(retryBatchKey)?.status !== "running")
          this.plugin.expansionBatches.delete(retryBatchKey);
        let reported = false;
        let skipped = 0;
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
              await this.researchChild(child, batchSignal, accepted, choices);
              return undefined;
            },
            () => {
              const state = this.plugin.expansionBatches.get(key);
              if (state && state.status !== "running" && !reported) {
                reported = true;
                new Notice(
                  t(
                    state.status === "stopped" ? "ui.multi_research_stopped" : "ui.multi_research_finished",
                    state.succeeded,
                    state.total,
                    state.failures.length,
                    skipped
                  )
                );
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
    if (failed.length)
      this.button(parent, t("ui.retry_failed_topics", failed.length), () => this.retryFailed(batchKey));
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
  private renderSelectionBar(workspace: HTMLElement): HTMLElement {
    const selection = workspace.createDiv("vam-selection-bar");
    const names = [...this.multiSelected].map(id => this.notes.get(id)?.title).filter(Boolean);
    selection.createSpan({
      text: this.multiSelected.size
        ? t("ui.selected_0_1_2", this.multiSelected.size, names.slice(0, 2).join("、"), names.length > 2 ? "…" : "")
        : t("ui.prompt_select_topics")
    });
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
    this.button(selection, t("ui.move_to"), () => this.chooseSelectedParent(false), !this.multiSelected.size);
    this.button(selection, t("ui.copy_to"), () => this.chooseSelectedParent(true), !this.multiSelected.size);
    const count = this.multiSelected.size;
    this.button(
      selection,
      count > 1 ? t("ui.synthesize_0_topics", count) : t("ui.synthesize"),
      () => this.integrateSelected(),
      count < 2
    ).addClass("mod-cta");
    if (!this.map?.aim && !this.builtIn) {
      // Not natively disabled: a disabled button cannot take focus, so keyboard and screen-reader users could not read why.
      const check = this.mergeCheck(),
        merge = this.button(selection, count > 1 ? t("ui.merge_0_topics", count) : t("ui.merge"), () =>
          this.openMerge()
        );
      if (!check.ok) {
        merge.setAttr("aria-disabled", "true");
        merge.setAttr("title", t(check.reason));
      }
    }
    if (!this.map?.aim) {
      const running = this.plugin.expansionBatches.get(this.multiResearchKey())?.status === "running";
      this.button(
        selection,
        count > 1 ? t("ui.research_0_topics", count) : count ? t("ui.research_one_topic") : t("ui.multi_research"),
        () => this.openMultiResearch(),
        !this.multiSelected.size || running
      );
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
  private async ancestorContext(node: MapNode): Promise<string> {
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
    const language = this.plugin.settings?.language ?? "zh-TW";
    for (const n of chain) {
      const info = await this.plugin.repo.readNote(n.path, this.map ?? undefined);
      ancestors.push(`- ${info.title}\n  ${labelCurrentSummary(language)}: ${info.summary}`);
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
    this.plugin.running.add(node.path);
    this.render();
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
      const task = synthesisDirectionsTask(this.plugin.settings.language);
      const result = await this.plugin.askModel(
        withThinkingOrigin(
          {
            title: note.title,
            summary: note.summary,
            rules: "",
            detail: note.detail,
            task: [task, options?.requirements].filter(Boolean).join("\n\n"),
            ancestors: await this.ancestorContext(node),
            referenceGroups: [...selectedSources, childSources],
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
        note.model,
        note.reasoning,
        options.signal,
        undefined,
        accepted
      );
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
    const children = this.map.nodes.filter(item => item.parentId === node.id);
    if (!children.length && !options?.referenceGroups?.some(group => group.documents.length)) {
      const message = t("ui.choose_another_note_source_first");
      if (failed) failed(message);
      else new Notice(message);
      return;
    }
    const childSources = await this.topicReferenceGroup(
      children,
      options?.synthesisContent === "summary" ? "summary" : "strong"
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
      note.thinkingOrigin
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
    try {
      const synthesisContext: TaskContext = withThinkingOrigin(
        {
          title: note.title,
          summary: note.summary,
          rules: "",
          detail: note.detail,
          task: [task, options?.requirements].filter(Boolean).join("\n\n"),
          ancestors: await this.ancestorContext(node),
          referenceGroups: [...selectedSources, childSources],
          onProgress: options?.onProgress,
          outputLanguage: options?.outputLanguage,
          ...this.toneField(note, options),
          mode: "synthesize",
          researchMode: options?.researchMode ?? "local",
          researchDepth: options?.researchDepth ?? note.researchDepth,
          visualMode: options?.visualMode ?? note.visualMode,
          detailTemplate,
          addCharts: true
        },
        note
      );
      const result = await this.plugin.askModel(
        synthesisContext,
        note.model,
        note.reasoning,
        options?.signal,
        undefined,
        accepted
      );
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
            options?.synthesisContent === "summary" ? "summary" : "strong"
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
              latest.thinkingOrigin
            ]) !== noteSnapshot
          )
            throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
          const canonical = canonicalDetail(
            detail,
            options?.outputLanguage ?? this.plugin.settings.language,
            detailTemplate
          );
          // An edited draft is checked again so the topic's format mark matches what is saved.
          const issues =
            result.formatIssues && detail !== result.detail
              ? checkCounts(canonical, detailTemplate)
              : result.formatIssues;
          await this.plugin.repo.updateNote(
            node.path,
            {
              summary,
              detail: canonical,
              visualReferences: visualReferencesMarkdown(result.visualReferences, language),
              newFindings: "",
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
              "status",
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
            model: note.model,
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
        await this.plugin.repo.updateNote(node.path, { status: "error" });
        const message = this.plugin.recordFailure(t("log.child_integration_failed"), error);
        if (failed) failed(message);
        else new Notice(message);
      }
    } finally {
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
      this.plugin.confirmAiUsage(note.model, async () => {
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
      "normal",
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
          (names.length > 2
            ? t("ui.synthesis_of_0_and_1_more", names[0], names.length)
            : t("ui.synthesis_of_0", names.join(t("ui.list_separator")))),
        defaultDirection: t("ui.identify_shared_conclusions_key_differences_tradeoffs_and_ne"),
        background: this.backgroundHooks(this.selectionTaskKey()),
        fields: {
          sources,
          templates: this.templateChoices(),
          currentTemplate: this.mapDetailTemplate(settings.language).name,
          tones: this.toneChoices(),
          currentTone: this.toneLabelFor({}),
          currentStyle: this.currentStyleLabel(this.mapDetailTemplate(settings.language).id, this.effectiveToneId({}))
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
      if (step === "draft") {
        await this.createIntegratedNode(title, sources, direction ?? "", "", runOptions, {
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
        base.synthesisContent === "summary" ? "summary" : "strong"
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
        progress: ""
      };
      this.integrationTask = task;
      own = task;
      this.render();
      const language = this.plugin.settings.language;
      const result = await this.plugin.askModel(
        {
          title,
          summary: translate(language, "note.no_conclusion_yet"),
          rules: "",
          detail: "",
          task: [synthesisDirectionsTask(language), runOptions.requirements].filter(Boolean).join("\n\n"),
          ancestors: "",
          referenceGroups: [...(runOptions.referenceGroups ?? []), sourceGroup],
          onProgress: runOptions.onProgress,
          outputLanguage: runOptions.outputLanguage,
          ...this.toneField(undefined, runOptions),
          mode: "synthesize",
          researchMode: runOptions.researchMode,
          researchDepth: runOptions.researchDepth,
          visualMode: "off"
        },
        this.plugin.settings.cliModel,
        this.plugin.settings.cliReasoning,
        controller.signal,
        undefined,
        markAccepted
      );
      markAccepted();
      if (this.integrationTask !== task) return;
      if (controller.signal.aborted || this.path !== task.mapPath || this.map?.id !== task.mapId)
        throw new DOMException("Aborted", "AbortError");
      const latest = await this.topicReferenceGroup(
        sources,
        base.synthesisContent === "summary" ? "summary" : "strong"
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
    void this.plugin.confirmAiUsage(this.plugin.settings.cliModel, async () => {
      await this.startSelectionSynthesis(
        task.sources,
        { ...retained, synthesisTitle: task.title, continuesDirections: task.directions.length > 0 },
        task.step === "directions" ? null : task.goal,
        message => new Notice(message),
        () => {}
      );
    });
  }
  private async topicReferenceGroup(
    sources: Pick<MapNode, "path">[],
    mode: "strong" | "summary" = "strong",
    /** `origin: false` leaves each note's Thinking Origin out (an AI merge never sends it). */
    options: { origin?: boolean } = {}
  ): Promise<ReferenceGroup> {
    const language = this.plugin.settings?.language ?? "zh-TW";
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
        `${labelCurrentSummary(language)}: ${note.summary || translate(language, "detail.no_conclusion_yet")}`,
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
    }
  ): Promise<void> {
    if (!this.map || sources.length < 2) return;
    const controller = flow?.controller ?? new AbortController();
    const mapPath = this.path,
      mapId = this.map.id;
    const sourceGroup = await this.topicReferenceGroup(
      sources,
      options?.synthesisContent === "summary" ? "summary" : "strong"
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
      progress: ""
    };
    this.integrationTask = task;
    this.render();
    const model = this.plugin.settings.cliModel;
    const language = this.plugin.settings.language;
    const detailTemplate = this.mapDetailTemplate(options?.outputLanguage ?? language, options?.detailTemplateId);
    try {
      const integrationContext: TaskContext = {
        title,
        summary: translate(language, "note.no_conclusion_yet"),
        rules: "",
        detail: "",
        task: [goal, options?.requirements].filter(Boolean).join("\n\n"),
        ancestors: "",
        referenceGroups: [...(options?.referenceGroups ?? []), sourceGroup],
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
        this.plugin.settings.cliReasoning,
        controller.signal,
        undefined,
        flow?.accepted
      );
      if (this.integrationTask !== task) return;
      if (controller.signal.aborted || this.path !== mapPath || this.map?.id !== mapId)
        throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
      const latest = await this.topicReferenceGroup(
        sources,
        options?.synthesisContent === "summary" ? "summary" : "strong"
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
    }
  }
  private async saveIntegratedNode(
    title: string,
    sources: MapNode[],
    goal: string,
    rules: string,
    model: string,
    result: AiResult,
    language: "zh-TW" | "en",
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
      task.options.synthesisContent === "summary" ? "summary" : "strong"
    );
    if (
      JSON.stringify(latest.documents) !== task.sourceContent ||
      sources.some(source => !this.map?.nodes.some(node => node.id === source.id && node.path === source.path))
    )
      throw new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    const integrated = await this.plugin.repo.createNote(title, model, this.map, this.path, "workspace");
    const detailTemplate = this.mapDetailTemplate(language, task.options.detailTemplateId);
    try {
      await this.plugin.repo.updateNote(
        integrated.path,
        {
          summary: result.summary,
          detail: canonicalDetail(result.detail, language, detailTemplate),
          visualReferences: visualReferencesMarkdown(result.visualReferences, language),
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
      await this.mapChange(map => {
        map.nodes.push(integrated);
      });
      const entry = this.history.undoEntry;
      if (entry) {
        entry.label = t("ui.confirm_new_synthesis_topic");
        // Undo takes the new topic off the map and parks its note in Unassigned; Redo brings both back.
        const mapUndo = entry.undo,
          mapRedo = entry.redo;
        let parked = "";
        entry.undo = async () => {
          parked = await this.plugin.repo.moveUnique(
            integrated.path,
            this.plugin.repo.topicFolder(this.path, "Unassigned")
          );
          await this.plugin.repo.setLifecycle(parked, this.map!.id, "", "unassigned");
          try {
            await mapUndo();
          } catch (error) {
            await this.plugin.repo.moveExact(parked, integrated.path);
            await this.plugin.repo.setLifecycle(integrated.path, this.map!.id, this.map!.id, "active");
            throw error;
          }
        };
        entry.redo = async () => {
          if (parked) {
            await this.plugin.repo.moveExact(parked, integrated.path);
            await this.plugin.repo.setLifecycle(integrated.path, this.map!.id, this.map!.id, "active");
          }
          await mapRedo();
        };
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
      if ((event.target as Element).closest(".vam-node") || !this.map) return;
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
  private enableDrag(card: HTMLElement, node: MapNode): void {
    card.addEventListener("pointerdown", event => {
      if (this.integrationMode || (event.target as Element).closest("button") || event.button !== 0 || !this.map)
        return;
      this.clearHoverTimer();
      this.hoverCard?.remove();
      this.hoverCard = null;
      // A previous drag whose release never arrived must not leave its listeners behind.
      this.dragCleanup?.();
      const currentNode = this.map.nodes.find(item => item.id === node.id);
      if (!currentNode) return;
      this.dragging = true;
      const start = { x: event.clientX, y: event.clientY },
        origin = { x: currentNode.x, y: currentNode.y };
      let position = { ...origin },
        moved = false;
      // Sizes and the far end of each touching edge are read once; a move then only writes.
      const edges = this.dragEdges(node.id, card);
      card.setPointerCapture(event.pointerId);
      const paint = (): void => {
        this.dragFrame = null;
        card.style.left = `${position.x}px`;
        card.style.top = `${position.y}px`;
        edges.update(position.x, position.y);
      };
      // A merging card stays where it is; the drop reports why.
      const locked = this.isMerging(node.id);
      let warned = false;
      const move = (e: PointerEvent): void => {
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
        this.dragging = false;
        if (this.dragFrame !== null) window.cancelAnimationFrame(this.dragFrame);
        this.dragFrame = null;
        card.removeEventListener("pointermove", move);
        card.removeEventListener("pointerup", finish);
        card.removeEventListener("pointercancel", finish);
        card.removeEventListener("lostpointercapture", finish);
        this.dragCleanup = null;
      };
      const finish = (e: PointerEvent): void => {
        settle();
        this.suppressClickUntil = Date.now() + 250;
        // The browser lost the pointer (or it was cancelled) without a release: put the card back.
        if (e.type === "pointercancel" || e.type === "lostpointercapture") {
          card.style.left = `${origin.x}px`;
          card.style.top = `${origin.y}px`;
          edges.update(origin.x, origin.y);
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
  /**
   * The edges touching one card, with the geometry they need already measured. `update` moves only those edges to
   * the dragged card's new position; every other edge stays untouched.
   */
  private dragEdges(id: string, card: HTMLElement): { update: (x: number, y: number) => void } {
    const size = { width: card.offsetWidth, height: card.offsetHeight };
    const touching: {
      key: string;
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
        dragIsParent: parentId === id,
        far: { x: other.offsetLeft, y: other.offsetTop, width: other.offsetWidth, height: other.offsetHeight }
      });
    }
    return {
      update: (x, y) => {
        for (const edge of touching) {
          // A background synchronize may redraw the edges mid-drag; always move the current path elements.
          const path = this.edgeEls.get(edge.key);
          if (!path) continue;
          if (edge.dragIsParent)
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
  private drawEdges(): void {
    if (!this.edgesEl || !this.stageEl || !this.map) return;
    this.edgesEl.replaceChildren();
    this.edgeEls.clear();
    for (const node of this.canvasNodes()) {
      const parents = parentIdsForNode(node);
      for (const parentId of parents) {
        const parent = this.cardEls.get(parentId),
          child = this.cardEls.get(node.id);
        if (!parent || !child) continue;
        const path = createSvg("path");
        path.setAttribute(
          "d",
          edgePathData(
            parent.offsetLeft + parent.offsetWidth,
            parent.offsetTop + parent.offsetHeight / 2,
            child.offsetLeft,
            child.offsetTop + child.offsetHeight / 2
          )
        );
        path.addClass("vam-edge");
        if (parentId !== node.parentId) path.addClass("vam-edge-convergence");
        if (!this.map.aim && !this.builtIn && this.notes.get(node.id)?.relevance?.tier === "side")
          path.addClass("vam-edge-side");
        this.edgesEl.appendChild(path);
        this.edgeEls.set(`${parentId}\u0000${node.id}`, path);
      }
    }
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
      settings.language
    );
  }
  /**
   * Template for content that has no topic choice of its own (new integrated topics, child contributions); a dialog
   * choice comes first.
   */
  private mapDetailTemplate(language: UiLanguage, chosenId?: string): DetailTemplate {
    const settings = this.plugin.settings;
    return templateInLanguage(
      resolveTemplate(
        settings.detailTemplates,
        [chosenId, this.map?.detailTemplateId, settings.defaultDetailTemplateId],
        settings.language
      ).template,
      language
    );
  }
  private async runAgent(
    node: MapNode,
    done?: (result: AiResult) => void,
    failed?: (message: string) => void,
    overrides?: Partial<TaskContext>,
    onLaunchAccepted?: () => void
  ): Promise<AgentTaskHandle | null> {
    const taskPath = node.path;
    const note = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
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
        summary: note.summary,
        rules: "",
        detail: note.detail,
        task: note.prompt,
        ancestors: await this.ancestorContext(node),
        workingFindings: note.newFindings,
        sourceContext: "",
        mode: "task",
        researchMode: note.researchMode,
        researchDepth: note.researchDepth,
        visualMode: note.visualMode,
        ...this.toneField(note, overrides),
        ...overrides,
        detailTemplate,
        addCharts: true
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
    const releaseStartup = (): void => {
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
        note.model,
        note.reasoning,
        controller.signal,
        id => {
          exchangeId = id;
        },
        markAccepted
      )
      .then(result =>
        this.plugin.mutate(async () => {
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
            latest.researchDepth !== note.researchDepth ||
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
                context.outputLanguage ?? this.plugin.settings.language,
                context.detailTemplate
              ),
              visualReferences: visualReferencesMarkdown(result.visualReferences, language),
              newFindings: "",
              status: "completed",
              ...formatIssuesPatch(result.formatIssues, language)
            },
            { detailTemplate: context.detailTemplate }
          );
          const saved = await this.plugin.repo.readNote(node.path, this.map ?? undefined);
          this.recordNoteWrite(
            node.path,
            { ...latest, status: note.status },
            saved,
            ["summary", "detail", "visualReferences", "newFindings", "previewSection", "previewInitialized", "status"],
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
            model: note.model,
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
          await this.plugin.repo.updateNote(node.path, { status: "error" });
          const message = this.plugin.recordFailure(t("log.ai_task_failed"), error);
          if (failed) failed(message);
          else new Notice(message);
        })
      )
      .finally(() => {
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
