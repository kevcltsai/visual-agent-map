/**
 * The plugin-level registry of topic AI runs: which topics have a run in flight and the controller that stops each.
 * It imports neither obsidian nor the view; everything it needs from the plugin comes through lazy ports, because the
 * plugin replaces some of those objects after construction.
 */
import { isBudgetExhausted } from "../../core/admission";
import { aiLockedError, isAiLockedError } from "../../core/ai-lock";
import { aiWriteGate } from "../../core/ai-write-gate";
import { isAiCard } from "./prompt-run";
import { noteLanguageOf, t, type ContentLanguage, type NoteLanguage, type UiLanguage } from "../../i18n";
import type { AiResult, ReasoningLevel, Suggestion, TaskContext } from "../../ai/types";
import type { DetailTemplate } from "../../ai/detail-templates";
import { documentsSnapshot, type ReferenceGroup } from "../../ai/reference-materials";
import {
  steerObserver,
  type ResearchObserver,
  type ResearchPreviewFields,
  type ResearchStageName,
  type ResearchSteer
} from "../../ai/research-observer";
import { canonicalDetail, visualReferencesMarkdown } from "../../ai/result-utils";
import { intakeAiMarkdown } from "../../ai/markdown-intake";
import { imageKeysIn } from "../../core/image-keys";
import { checkCounts, standardTemplate } from "../../ai/detail-templates";
import { carryForwardSources } from "../../core/steps/task/carry-sources";
import { keepDroppedContent } from "../../core/steps/task/merge-check";
import { failureReason, type Note, type NotePatch } from "../../repository";
import type { RunStyle } from "../../ai/note-style-store";
import type { UpdateMode } from "../../ai/note-style-recipe";
import {
  chartPreserves,
  composeWriteback,
  type WritebackInput,
  type WritebackMode,
  type WritebackRecord,
  type WritebackResult
} from "../../ai/note-writeback";
import { runStyleLabelText } from "../../ai/note-style-label";
import type { MapDocument, MapNode } from "../../map-model";
import type { ModelChoice } from "../../ai/model-resolution";
import type { AgentTaskHandle, RunOnceModel, SynthesisObserver, TaskOptions } from "./modals";
import { withThinkingOrigin } from "./thinking-origin";
import { neutralizeText } from "../../core/book-pipeline/note-sections";
import { formatIssuesPatch, originBaseline, summaryForPrompt } from "./note-write-helpers";

/** Which note the run read: another note at the same path (a different map or topic id) is not the run's topic. */
const noteIdentity = (note: Note): string => `${note.mapId}\n${note.topicId}`;

/** Everything a research result is written over: a different value at commit means the topic changed while the AI ran. */
const researchVersion = (note: Note, status: string | undefined): string =>
  JSON.stringify([
    status,
    note.newFindings,
    note.visualReferences,
    note.thinkingOrigin,
    note.title,
    note.prompt,
    note.rules,
    note.detail,
    note.summary,
    note.model,
    note.reasoning,
    note.researchMode,
    note.visualMode,
    note.sourcePaths,
    note.referencePaths
  ]);

/** Chart steps that may run at once; further jobs wait in a first-in-first-out queue. */
export const CHART_JOB_LIMIT = 3;

export type TopicRunKind =
  "research" | "proposeChildren" | "integrateDirection" | "integrateChildren" | "synthesizeSelection";

/** The i18n key of the Stop button on a card: expanding (proposing subtopics) is not research. */
export function stopLabelKey(
  kind: TopicRunKind | undefined,
  quickExpandPending: boolean,
  startingExpand = false
): "ui.stop_expand" | "ui.stop_research" {
  return startingExpand || quickExpandPending || kind === "proposeChildren" ? "ui.stop_expand" : "ui.stop_research";
}

/** The part of the AI task service the chart step uses. */
export interface ChartTasks {
  chartEligible(context: TaskContext): boolean;
  chartDetail(request: {
    input: TaskContext;
    detail: string;
    countIssues?: AiResult["formatIssues"];
    model: string;
    signal?: AbortSignal;
    onExchange?: (id: string) => void;
  }): Promise<string>;
  failExchange(id: string, reason: string): void;
}

/** The part of the research progress store the chart step uses. */
export interface ChartProgress {
  begin(path: string, attemptId: string, now: number, model?: string): void;
  stage(path: string, attemptId: string, stage: "charts", now: number): void;
  end(path: string, attemptId?: string): void;
}

export interface ChartJob {
  path: string;
  context: TaskContext;
  /** The detail exactly as written to the note. */
  detail: string;
  countIssues?: AiResult["formatIssues"];
  model: string;
  apply: (detail: string) => Promise<boolean>;
}

/** The part of the research progress store a research run uses. */
export interface RunProgress extends ChartProgress {
  begin(path: string, attemptId: string, now: number, model?: string, label?: string): void;
  newAttempt(path: string, attemptId: string, now: number): void;
  stage(path: string, attemptId: string, stage: ResearchStageName | "charts", now: number, query?: string): void;
  preview(path: string, attemptId: string, fields: ResearchPreviewFields): void;
  markSlow(path: string, attemptId: string, slow: boolean, resend?: () => void): void;
}

/** The part of the repository a research run uses. */
export interface RunRepository {
  isDisposed?(): boolean;
  readNote(path: string, map?: MapDocument): Promise<Note>;
  /** The exact file text used to parse the note, for an atomic result commit. */
  readNoteSnapshot?(path: string, map?: MapDocument): Promise<{ note: Note; content: string }>;
  settleRunningNote?(path: string, patch: Pick<NotePatch, "status" | "lastError">): Promise<void>;
  updateNote(
    path: string,
    patch: NotePatch,
    options?: { detailTemplate?: DetailTemplate; newVisualReferences?: boolean }
  ): Promise<void>;
  /** The guarded write (Repository.updateNoteGuarded); the real repository checks at the vault write boundary. */
  updateNoteGuarded?(
    path: string,
    patch: NotePatch,
    options?: {
      detailTemplate?: DetailTemplate;
      newVisualReferences?: boolean;
      expectedContent?: string;
      authorize?: (current?: string) => boolean;
      finalize?: (content: string) => string | null;
    }
  ): Promise<"written" | "discarded">;
  resolveTopicModel(
    path: string,
    map?: MapDocument,
    runOnce?: RunOnceModel | null
  ): Promise<{ model: string; reasoning?: ReasoningLevel }>;
}

export interface RunExchanges {
  failed(id: string, reason: string): void;
  completed(id: string): void;
  getEntries(): readonly { id: string; status?: string }[];
}

export interface TopicRunPorts {
  /** Read on every use, never captured at construction. */
  aiTasks(): ChartTasks;
  mutate(): (work: () => Promise<void>) => Promise<void>;
  progress(): RunProgress;
  repository(): RunRepository | undefined;
  /** The plugin's own Map of controllers the Stop buttons and the AI service look up by topic path. */
  activeTasks(): Map<string, AbortController>;
  askModel(
    context: TaskContext,
    model: string,
    reasoning?: ReasoningLevel,
    signal?: AbortSignal,
    onExchange?: (id: string) => void,
    onRequestAccepted?: () => void,
    onWebSearchEvent?: undefined,
    observer?: ResearchObserver
  ): Promise<AiResult>;
  settings(): { language: UiLanguage; aiExchangeLoggingEnabled?: boolean };
  exchanges(): RunExchanges | null | undefined;
  recordFailure(context: string, error: unknown): string;
  /** The note style of a topic when the caller gave none (the entry that has the map and notices passes its own). */
  runStyle(input: { note: Note; outputLanguage: ContentLanguage; rewrite?: boolean }): RunStyle;
  /** The model and reasoning a run-once choice resolves to for a topic. */
  resolveModel(
    path: string,
    map: MapDocument | undefined,
    runOnce: RunOnceModel
  ): ReturnType<RunRepository["resolveTopicModel"]>;
  /** Every open view except `origin` forgets its undo history (the note was changed by an AI run). */
  clearOtherHistory(origin: unknown): void;
  /** Every open view reloads and redraws after a run settles. */
  refreshViews(): void;
  /** Test seam: replaces the pure write-back composer (a test uses it to prove a failed top invariant writes nothing). */
  composeWriteback?: (input: WritebackInput) => WritebackResult;
  /** The plugin's own Set and Map, read on every use: tests and onload replace them. */
  running(): Set<string>;
  pendingSuggestions(): Map<string, Suggestion[]>;
}

/** The backup and raw-read hooks the "fresh" write-back needs; the view builds them over the vault. */
export interface WritebackHooks {
  /** Copies the note file (its whole text, `content`) to the backup folder; never throws. */
  backupNote?: (path: string, content: string) => Promise<{ ok: true; path: string } | { ok: false }>;
  /** The whole text of the note file as it is on disk now. */
  readRaw?: (path: string) => Promise<string>;
}

/** The note file's text before a run changed anything, and after it marked the topic running. */
interface RawSnapshot {
  original: string;
  started: string;
}

/** The job the view's chart step gets after a write-back. */
export interface QueuedCharts {
  path: string;
  saved: Note;
  context: TaskContext;
  detail: string;
  formatIssues?: AiResult["formatIssues"];
  model: string;
  language: ContentLanguage;
  template?: DetailTemplate;
  /** "top": the diagrams may only be applied when `preserve` accepts the diagrammed text. */
  updateMode?: UpdateMode;
  preserve?: (charted: string) => boolean;
}

/** What a research run needs from the entry that starts it (the view); every function is optional where a run can go on without it. */
export interface ResearchStart extends WritebackHooks {
  /** The caller's identity: the view that started the run keeps its undo, every other view clears its history. */
  origin?: unknown;
  map?: MapDocument;
  /** The map file the run's token usage is counted under. */
  usageMapPath?: string;
  request?: Partial<TaskContext> & { runStyle?: RunStyle };
  runOnce?: RunOnceModel;
  done?: (result: AiResult) => void;
  failed?: (message: string) => void;
  /** Shows a message when `failed` is not given. */
  notify?: (message: string) => void;
  /** Called once the AI accepted the request. */
  accepted?: () => void;
  /** Resolves the note style when `request.runStyle` is not given (the view's version also writes choices and shows notices). */
  resolveStyle?: (language: ContentLanguage) => Promise<RunStyle>;
  ancestors?: (language: ContentLanguage) => Promise<string>;
  userTexts?: () => string;
  /** The anchors of annotated images that relate to this topic, as a read-only block; "" adds nothing (annotated-image P5b). */
  anchorContext?: (language: ContentLanguage) => string;
  /** Runs after the status was set to running (the view reloads and redraws). */
  onStarted?: () => Promise<void>;
  /** The note before and after the write, for the starting view's undo. */
  onWritten?: (change: { before: Note; after: Note }) => void;
  /** Queues the background chart step for the note that was just written. */
  queueCharts?: (job: QueuedCharts) => void;
  /** Takes user additions while the main call runs (the topic chat window). Absent: the run is exactly as before. */
  steer?: ResearchSteer;
  /**
   * The picture-book pipeline's author step only; absent: the run is exactly as before. `authorize` is checked inside the
   * write itself (with the file text the run started from), so a stopped or replaced pipeline run, or a note the owner
   * changed after the last read, writes nothing. `onBudgetExhausted` hears the call budget's refusal as its own outcome:
   * the topic gets its old status back and no error is recorded. `onDiscarded` hears that the result was dropped because the
   * topic changed or the guarded write was refused (the failure text still goes to `failed`; callers must not match it).
   */
  pipeline?: {
    authorize: (current?: string) => boolean;
    /** Runs on the file text inside the write itself; null refuses the write (the author's body is never saved unchecked). */
    finalize: (content: string) => string | null;
    onBudgetExhausted: () => void;
    onDiscarded?: () => void;
    /** The write leaves the note's Summary as it is (a chapter expansion: the answer only describes what it added). */
    keepSummary?: boolean;
    /** A failed call leaves the note's status as it was (an in-place fix of a chapter that keeps its text is never an error card; live v6). */
    keepStatusOnFailure?: boolean;
  };
}

/** What a child-topic proposal run needs from the entry that starts it (the view). */
export interface ProposeStart {
  map?: MapDocument;
  runOnce?: RunOnceModel;
  /** The dialog's Stop signal: aborting it stops the run. */
  signal?: AbortSignal;
  outputLanguage?: ContentLanguage;
  /** Builds the request from the note and the output language (the view knows the map, ancestors and tone). */
  buildContext: (note: Note, outputLanguage: ContentLanguage) => Promise<TaskContext>;
  /** Called once the AI accepted the request (not after Stop). */
  accepted?: () => void;
  /** Runs right after the topic was registered (the view marks it pending and redraws). */
  onStarted?: () => void;
  /** Runs once the topic was freed, before the run settles. */
  onReleased?: () => void;
  /** Called with the pending suggestions once they are stored; the entry shows them. */
  offer: (items: Suggestion[]) => void;
  failed?: (message: string, retryable?: boolean) => void;
  /** Shows a message when `failed` is not given. */
  notify?: (message: string) => void;
  /** Tells a failure the entry knows: "partial" (some children were created) or "stopped" (the batch was stopped). */
  classifyError?: (error: unknown) => "partial" | "stopped" | undefined;
  /** Runs when the suggestions are stored, before they are offered (the view saves the research choices). */
  onStored?: () => void;
}

/** What an integration-directions run needs from the entry that starts it (the view). */
export interface IntegrateDirectionStart {
  /** Read on every use: the view replaces its map object when it reloads. */
  map: () => MapDocument | undefined;
  runOnce?: RunOnceModel;
  /** The dialog's Stop signal: it is the only way to stop this run. */
  signal?: AbortSignal;
  /** Returns a message when the run must not start (no sources); checked after the running guard. */
  precheck?: () => string | undefined;
  /** Runs right after the topic was registered (the view redraws). */
  onStarted?: () => void;
  /** Builds the request, or returns a message when the sources hold nothing to synthesize. */
  buildContext: (note: Note) => Promise<TaskContext | string>;
  /** Called once the AI accepted the request. */
  accepted?: () => void;
  found: (items: Suggestion[]) => void;
  failed: (message: string) => void;
  /** Runs after the topic was freed, before the run settles (the view reloads and redraws). */
  onSettled?: () => Promise<void>;
}

/** The view-side checks an integrate-children run makes again before it writes. */
export interface IntegratePrepared {
  detailTemplate: DetailTemplate;
  /** How the result is written back; absent means merge. */
  updateMode?: UpdateMode;
  /** True when the map, its open view or the topic's children are no longer what the run started with. */
  viewChanged: () => boolean;
  /** True when the child sources read now differ from the ones the run started with. */
  sourcesChanged: () => Promise<boolean>;
}

/** Writes the result (or lets a review step hold it): `save` re-checks everything and throws without writing when the topic changed. */
export type IntegrateWrite = (
  result: AiResult,
  save: (summary: string, detail: string) => Promise<void>,
  summary: string,
  detail: string,
  note: Note
) => void | Promise<void>;

/** What an integrate-children run needs from the entry that starts it (the view). */
export interface IntegrateChildrenStart extends WritebackHooks {
  map: () => MapDocument | undefined;
  runOnce?: RunOnceModel;
  signal?: AbortSignal;
  outputLanguage?: ContentLanguage;
  /** Checks sources and reads the note style before anything is registered; a string is the message to show instead. */
  prepare: (note: Note) => Promise<IntegratePrepared | string>;
  /** Runs after the status was set to running (the view reloads and redraws). */
  onStarted?: () => Promise<void>;
  buildContext: (note: Note) => Promise<TaskContext>;
  /** True only when the whole of the parent's Working Findings was in the prompt. */
  findingsSent: () => boolean;
  accepted?: () => void;
  drafted: IntegrateWrite;
  /** The note before and after the write: the view records undo, reloads and redraws. */
  onWritten: (change: { before: Note; after: Note }) => Promise<void>;
  queueCharts?: ResearchStart["queueCharts"];
  failed?: (message: string) => void;
  notify?: (message: string) => void;
  /** Runs after the topic was freed, before the run settles (the view reloads and redraws). */
  onSettled?: () => Promise<void>;
  /** Takes user additions while the main call runs. Absent: the run is exactly as before. */
  steer?: ResearchSteer;
}

/**
 * What a selection-synthesis run needs from the entry that starts it (the view). The run belongs to a map, not to one
 * topic: it is registered under the map's path like any other run, so Stop, stopAll and dispose reach it through
 * `stop`. The state it shows lives in {@link TopicRuns.startSelectionSynthesis} (per owning view).
 */
export interface SynthesizeSelectionStart {
  /** "directions" asks for suggested directions; "draft" writes the new topic. */
  step: "directions" | "draft";
  /** The stop signal of the view's waiting task. */
  signal: AbortSignal;
  /** Aborts the view's waiting task (its controller); called when the registered run is stopped. */
  stop: () => void;
  /** Called when the map already has a run, instead of starting; none of the other callbacks run. */
  refused: () => void;
  /** The model for the selected topics. */
  model: () => Promise<{ model: string; reasoning?: ReasoningLevel }>;
  /** The selected topics' notes as one reference group; read again before anything is saved to compare. */
  readSources: () => Promise<ReferenceGroup>;
  /** Registers the waiting task for the sources just read and redraws. */
  begin: (sources: ReferenceGroup) => void;
  startProgress: (model: string) => { observer?: ResearchObserver; end: () => void };
  buildContext: (sources: ReferenceGroup) => Promise<TaskContext>;
  /** Called once the AI accepted the request. */
  accepted: () => void;
  /** False when the waiting task was discarded or replaced meanwhile. */
  current: () => boolean;
  /** True when the open map is no longer the one the run started with. */
  mapChanged: () => boolean;
  /** The sources as the waiting task recorded them (compared with a fresh read). */
  recordedSources: () => string;
  /** Directions step: the found directions (at most 2) are stored and offered; null suggestions go to `noDirections`. */
  found: (items: Suggestion[]) => void;
  noDirections: () => void;
  /** Draft step: true when the view was closed. */
  closed: () => boolean;
  /** Draft step: marks the task as applying and returns the undo mark taken before the write. */
  applying: () => unknown;
  /** Draft step: creates the topic; throws without writing when the sources or the map changed. */
  write: (result: AiResult) => Promise<void>;
  written: (undoMark: unknown) => void;
  /** Draft step: an error after the task existed; may rethrow (the view decides which errors reach `fail`). */
  draftFailed: (error: unknown) => void;
  /** Draft step: the run ended without throwing. */
  finished: () => void;
  fail: (error: unknown) => void;
  /** Runs last, whatever happened. */
  settled: () => void;
}

/** A multi-select synthesis the view shows (a selection bar row); its state lives in {@link TopicRuns.syntheses}. */
export interface SelectionSynthesisTask {
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
}

/** One topic's integration (directions, then draft) the view shows on the card. */
export interface TopicSynthesisTask {
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

/** What one view has in flight: the selection synthesis, a start in progress, and one integration per topic path. */
export interface SynthesisState {
  selection: SelectionSynthesisTask | null;
  /** A multi-select synthesis step is starting (before its task exists), so a second request is refused. */
  selectionStarting: boolean;
  readonly topics: Map<string, TopicSynthesisTask>;
}

/** What a single-topic integration needs from the entry that starts it (the view); the state transitions live in TopicRuns. */
export interface TopicSynthesisStart {
  mapPath: string;
  mapId: string;
  options: TaskOptions;
  /** null: ask for directions first; otherwise write the draft. */
  direction: string | null;
  failed: (message: string) => void;
  accepted: () => void;
  observer?: SynthesisObserver & { onWritten?: () => void };
  /** The view redraws. */
  changed: () => void;
  directions: (
    runOptions: TaskOptions,
    found: (items: Suggestion[]) => void,
    fail: (message: string) => void,
    accepted: () => void
  ) => Promise<void>;
  draft: (
    runOptions: TaskOptions,
    direction: string,
    drafted: (
      result: AiResult,
      save: (summary: string, detail: string) => Promise<void>,
      summary: string,
      detail: string
    ) => Promise<void>,
    fail: (message: string) => void,
    accepted: () => void
  ) => Promise<void>;
  /** The undo mark taken just before the write. */
  undoMark: () => unknown;
  /** Runs after the write (the view shows its undo notice). */
  written: (undoMark: unknown) => void;
}

/** What a multi-select synthesis needs from the entry that starts it (the view); the state transitions live in TopicRuns. */
export interface SelectionSynthesisStart {
  sources: MapNode[];
  options: TaskOptions;
  /** null: ask for directions first; otherwise write the draft. */
  direction: string | null;
  failed: (message: string) => void;
  accepted: () => void;
  observer?: SynthesisObserver;
  /** The thin entry's own sink: it rethrows the original error to its caller. */
  errorSink?: (error: unknown) => void;
  /** The open map when the run started. */
  mapPath: string;
  mapId: string;
  /** The view redraws. */
  changed: () => void;
  model: () => Promise<ModelChoice>;
  readSources: (mode: "strong" | "summary", language: TaskOptions["outputLanguage"]) => Promise<ReferenceGroup>;
  startProgress: (model: string) => { observer?: ResearchObserver; end: () => void };
  /** `progress` is the draft step's progress sink (it ignores a replaced task); the directions step uses `runOptions.onProgress`. */
  buildContext: (
    group: ReferenceGroup,
    task: SelectionSynthesisTask,
    runOptions: TaskOptions,
    progress: (message: string) => void
  ) => Promise<TaskContext>;
  /** Creates the topic (the view's write port); throws without writing when the sources or the map changed. */
  write: (result: AiResult, task: SelectionSynthesisTask, model: string) => Promise<void>;
  /** Runs after the write (the view shows its undo notice). */
  written: (undoMark: unknown, task: SelectionSynthesisTask) => void;
  /** The directions are ready but their dialog is closed: the view tells the user and can reopen it. */
  offerDirections: (waiting: SelectionSynthesisTask) => void;
  mapChanged: (mapPath: string, mapId: string) => boolean;
  closed: () => boolean;
  /** The undo mark taken just before the write. */
  undoMark: () => unknown;
}

interface ResearchPrelude {
  note: Note;
  used: { model: string; reasoning?: ReasoningLevel };
  context: TaskContext;
  styleLabel: string | undefined;
}

export interface TopicRunHandle {
  readonly path: string;
  readonly kind: TopicRunKind;
  readonly signal: AbortSignal;
  /** Frees the topic. A release from a run that was already replaced does nothing. */
  release(): void;
}

export class TopicRuns {
  /** Topics with a run in flight: the Set the plugin holds as `running`, read through the port. */
  get running(): Set<string> {
    return this.ports.running();
  }
  private readonly controllers = new Map<string, AbortController>();
  private readonly kinds = new Map<string, TopicRunKind>();
  private disposed = false;
  /** Background chart steps (running and queued), keyed by note path: one per path, at most {@link CHART_JOB_LIMIT} run at a time. */
  private readonly charts = new Map<string, AbortController>();
  /** The progress entry each background chart job owns (the research run's own entry ends when the note is written). */
  private readonly chartProgressIds = new Map<string, string>();
  private chartProgressSeq = 0;
  /** Jobs waiting for a free slot, first in first out. */
  private readonly chartQueue: Array<{ controller: AbortController; start: () => void }> = [];
  private chartRunning = 0;
  /** What each open view has in flight for synthesis: a closed view's entry goes away with the view. */
  private readonly synthesisStates = new WeakMap<object, SynthesisState>();
  /** The redraw hook of each view's selection synthesis, kept for {@link stopSelection}. */
  private readonly selectionChanged = new WeakMap<object, () => void>();

  constructor(readonly ports: TopicRunPorts) {}

  /**
   * Registers a run for the topic. Returns null when the topic already has one or the module is disposed. Every run
   * calls this synchronously, before its first await, so a second click on the same topic is refused.
   */
  begin(path: string, kind: TopicRunKind): TopicRunHandle | null {
    if (this.disposed || this.controllers.has(path)) return null;
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.kinds.set(path, kind);
    this.running.add(path);
    return {
      path,
      kind,
      signal: controller.signal,
      release: () => {
        if (this.controllers.get(path) !== controller) return;
        this.controllers.delete(path);
        this.kinds.delete(path);
        this.running.delete(path);
        this.wakeIdleWaiters();
      }
    };
  }

  /** Callers waiting in {@link whenIdle}; woken whenever a run or chart step ends. */
  private readonly idleWaiters = new Set<() => void>();
  private wakeIdleWaiters(): void {
    for (const wake of [...this.idleWaiters]) wake();
  }

  /**
   * Resolves once none of the topics has a run or a background chart step in flight (or `signal` aborts). A run that
   * reads other topics as its sources calls this first: a child's research writing back during the read-to-save
   * window would otherwise look like an edit and fail the sources check, though the user touched nothing.
   */
  async whenIdle(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    const busy = (): boolean => paths.some(path => this.running.has(path) || this.charts.has(path));
    while (busy() && !signal?.aborted && !this.disposed) {
      await new Promise<void>(resolve => {
        const wake = (): void => {
          this.idleWaiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        this.idleWaiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  /**
   * Runs a research on one topic: reads the note, resolves model and style, registers (the topic is `running`), asks
   * the model, then checks the note against what the run started from and writes the answer in one mutate. Resolves
   * with null when the run did not start, otherwise with a handle whose `finished` settles when the run is over.
   * The caller says what the run should look like; this decides when each step happens.
   */
  start(path: string, kind: "research", options: ResearchStart): Promise<AgentTaskHandle | null>;
  /**
   * Proposes child topics: registers the run, asks the model, stores the suggestions that await a decision and offers
   * them. Resolves when the run is over. Creating the topics from a suggestion stays with the entry.
   */
  start(path: string, kind: "proposeChildren", options: ProposeStart): Promise<void>;
  /** Asks for synthesis directions over the child topics and the chosen sources. Resolves when the run is over. */
  start(path: string, kind: "integrateDirection", options: IntegrateDirectionStart): Promise<void>;
  /** Rewrites a topic from its children and the chosen sources, unless it changed meanwhile. Resolves when the run is over. */
  start(path: string, kind: "integrateChildren", options: IntegrateChildrenStart): Promise<void>;
  /** Synthesizes the selected topics into a new topic: directions first, then the draft. `path` is the map's. Resolves when the run is over. */
  start(path: string, kind: "synthesizeSelection", options: SynthesizeSelectionStart): Promise<void>;
  async start(
    path: string,
    kind: TopicRunKind,
    options: ResearchStart | ProposeStart | IntegrateDirectionStart | IntegrateChildrenStart | SynthesizeSelectionStart
  ): Promise<AgentTaskHandle | null | void> {
    if (kind === "synthesizeSelection") return this.runSelection(path, options as SynthesizeSelectionStart);
    if (kind === "proposeChildren") return this.runProposal(path, options as ProposeStart);
    if (kind === "integrateDirection") return this.runDirections(path, options as IntegrateDirectionStart);
    if (kind === "integrateChildren") return this.runIntegration(path, options as IntegrateChildrenStart);
    return this.startResearch(path, kind, options as ResearchStart);
  }

  private async runProposal(path: string, options: ProposeStart): Promise<void> {
    const fail = (message: string, retryable?: boolean): void => {
      if (options.failed) options.failed(message, retryable);
      else options.notify?.(message);
    };
    if (this.running.has(path)) {
      options.failed?.(t("ui.ai_running_ai"));
      return;
    }
    const handle = this.begin(path, "proposeChildren");
    if (!handle) return;
    const controller = this.controllers.get(path)!;
    const modalSignal = options.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    let accepted = false;
    const acceptDispatch = (): void => {
      if (accepted || controller.signal.aborted) return;
      accepted = true;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      options.accepted?.();
    };
    const activeTasks = this.ports.activeTasks();
    activeTasks.set(path, controller);
    options.onStarted?.();
    const aborted = (): DOMException => new DOMException("Aborted", "AbortError");
    try {
      const repo = this.ports.repository()!;
      const note = await repo.readNote(path, options.map);
      // AI lock: no subtopics are proposed for a locked topic (no AI call).
      if (note.aiLocked) {
        fail(t("ui.ai_locked_notice"), false);
        return;
      }
      const used = options.runOnce?.model.trim()
        ? await this.ports.resolveModel(path, options.map, options.runOnce)
        : { model: note.model, reasoning: note.reasoning };
      if (controller.signal.aborted) throw aborted();
      const outputLanguage = options.outputLanguage ?? this.ports.settings().language;
      const result = await this.ports.askModel(
        await options.buildContext(note, outputLanguage),
        used.model,
        used.reasoning,
        controller.signal,
        undefined,
        acceptDispatch
      );
      if (!accepted) acceptDispatch();
      if (controller.signal.aborted) throw aborted();
      const suggestions = result.suggestions.filter(item => !item.parentTitle).slice(0, 7);
      if (suggestions.length === 0) {
        fail(result.detail.trim() || t("ui.ai_does_not_recommend_decomposition_or_did_not_propose_3_to"));
        return;
      }
      const latest = await repo.readNote(path, options.map);
      if (controller.signal.aborted) throw aborted();
      // The late-result fence: suggestions for a topic locked meanwhile are not kept.
      if (latest.aiLocked) {
        fail(t("ui.ai_locked_notice"), false);
        return;
      }
      if (latest.thinkingOrigin !== note.thinkingOrigin)
        throw new Error(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
      const pendingItems = suggestions.map(item => ({
        ...item,
        thinkingOriginBaseline: originBaseline(note.thinkingOrigin)
      }));
      const flush = async (): Promise<void> => {
        await (this.pendingSuggestions as { flush?: () => Promise<void> }).flush?.();
      };
      this.pendingSuggestions.set(path, pendingItems);
      await flush();
      if (controller.signal.aborted) {
        this.pendingSuggestions.delete(path);
        await flush();
        throw aborted();
      }
      options.onStored?.();
      options.offer(pendingItems);
    } catch (error) {
      const kind = options.classifyError?.(error);
      const cancelled = kind !== "partial" && (controller.signal.aborted || kind === "stopped");
      if (!cancelled) {
        console.error("Visual Agent Map AI split", error);
        fail(this.ports.recordFailure(t("log.ai_split_failed"), error), kind !== "partial");
      }
    } finally {
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      if (activeTasks.get(path) === controller) activeTasks.delete(path);
      handle.release();
      options.onReleased?.();
    }
  }

  /** One signal that aborts when the registered run is stopped (Stop, stopAll, dispose) or the entry's own signal aborts. */
  private linked(handle: TopicRunHandle, external?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (handle.signal.aborted || external?.aborted) controller.abort();
    handle.signal.addEventListener("abort", abort, { once: true });
    external?.addEventListener("abort", abort, { once: true });
    return {
      signal: controller.signal,
      dispose: () => {
        handle.signal.removeEventListener("abort", abort);
        external?.removeEventListener("abort", abort);
      }
    };
  }

  /** One progress entry, owned by this request until it ends or another job replaces it. */
  private startProgress(
    path: string,
    model: string,
    style?: string,
    replace = false
  ): { observer?: ResearchObserver; end: () => void } {
    const progress = this.ports.progress() as (RunProgress & { get?(path: string): unknown }) | undefined;
    if (!progress || (!replace && progress.get?.(path))) return { end: () => {} };
    let attempt = "starting";
    let ended = false;
    progress.begin(path, attempt, Date.now(), model, style);
    const entry = progress.get?.(path);
    const owns = (): boolean => !ended && (!progress.get || (entry !== undefined && progress.get(path) === entry));
    const observer: ResearchObserver = {
      onAttempt: id => {
        if (!owns()) return;
        attempt = id;
        progress.newAttempt(path, id, Date.now());
      },
      onStage: (id, stage, query) => {
        if (owns()) progress.stage(path, id, stage, Date.now(), query);
      },
      onPreview: (id, fields) => {
        if (owns()) progress.preview(path, id, fields ?? {});
      }
    };
    if (replace)
      observer.onSlow = (id, slow, resend) => {
        if (owns()) progress.markSlow(path, id, slow, resend);
      };
    return {
      observer,
      end: () => {
        if (!owns()) return;
        ended = true;
        progress.end(path, attempt);
      }
    };
  }

  private async modelOf(
    path: string,
    note: Note,
    map: MapDocument | undefined,
    runOnce?: RunOnceModel
  ): Promise<{ model: string; reasoning?: ReasoningLevel }> {
    return runOnce?.model.trim()
      ? await this.ports.resolveModel(path, map, runOnce)
      : { model: note.model, reasoning: note.reasoning };
  }

  private async runDirections(path: string, options: IntegrateDirectionStart): Promise<void> {
    if (this.running.has(path)) {
      options.failed(t("ui.ai_running_ai"));
      return;
    }
    const handle = this.begin(path, "integrateDirection");
    if (!handle) return;
    const link = this.linked(handle, options.signal);
    const free = (): void => {
      link.dispose();
      handle.release();
    };
    try {
      const blocked = options.precheck?.();
      if (blocked) {
        options.failed(blocked);
        return;
      }
      const repo = this.ports.repository()!;
      const note = await repo.readNote(path, options.map());
      // AI lock: the directions lead to a rewrite of this topic, so a locked topic is refused before any AI call.
      if (note.aiLocked) {
        options.failed(t("ui.ai_locked_notice"));
        return;
      }
      const used = await this.modelOf(path, note, options.map(), options.runOnce);
      options.onStarted?.();
      const progress = this.startProgress(path, used.model);
      try {
        const context = await options.buildContext(note);
        if (typeof context === "string") {
          options.failed(context);
          return;
        }
        const result = await this.ports.askModel(
          context,
          used.model,
          used.reasoning,
          link.signal,
          undefined,
          options.accepted,
          undefined,
          progress.observer
        );
        progress.end();
        options.accepted?.();
        if (link.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const angles = result.suggestions.slice(0, 2);
        if (!angles.length) {
          options.failed(t("ui.ai_did_not_suggest_a_synthesis_direction_please_retry"));
          return;
        }
        options.found(angles);
      } catch (error) {
        if (link.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          options.failed(t("ui.research_stopped_existing_content_was_preserved"));
          return;
        }
        console.error("Visual Agent Map integration directions", error);
        options.failed(this.ports.recordFailure(t("log.integration_directions_failed"), error));
      } finally {
        progress.end();
        free();
        await options.onSettled?.();
      }
    } finally {
      free();
    }
  }

  private async runIntegration(path: string, options: IntegrateChildrenStart): Promise<void> {
    if (this.running.has(path)) {
      options.failed?.(t("ui.ai_running_ai"));
      return;
    }
    const handle = this.begin(path, "integrateChildren");
    if (!handle) return;
    const link = this.linked(handle, options.signal);
    const free = (): void => {
      link.dispose();
      handle.release();
    };
    try {
      await this.integrate(path, options, link.signal, free);
    } finally {
      free();
    }
  }

  private async integrate(
    path: string,
    options: IntegrateChildrenStart,
    signal: AbortSignal,
    free: () => void
  ): Promise<void> {
    const fail = (message: string): void => {
      if (options.failed) options.failed(message);
      else options.notify?.(message);
    };
    const repo = this.ports.repository()!;
    const note = await repo.readNote(path, options.map());
    if (isAiCard(note)) {
      fail(t("ui.living_node_use_run_card"));
      return;
    }
    // AI lock: a locked topic is refused before anything is written or any AI call is made.
    if (note.aiLocked) {
      fail(t("ui.ai_locked_notice"));
      return;
    }
    const used = await this.modelOf(path, note, options.map(), options.runOnce);
    const noteSnapshot = (item: Note): string =>
      JSON.stringify([
        item.title,
        item.summary,
        item.detail,
        item.prompt,
        item.rules,
        item.model,
        item.reasoning,
        item.sourcePaths,
        item.referencePaths,
        item.thinkingOrigin,
        item.newFindings
      ]);
    const snapshot = noteSnapshot(note);
    const prepared = await options.prepare(note);
    if (typeof prepared === "string") {
      fail(prepared);
      return;
    }
    const language = this.ports.settings().language;
    const outputLanguage = options.outputLanguage ?? language;
    const detailTemplate = prepared.detailTemplate;
    this.abortCharts(path);
    let original: string | null = null;
    try {
      original = await this.readOriginal(prepared.updateMode ?? "merge", path, options);
      // A "fresh" write needs the file for its backup: when it cannot be read, stop before any AI call is spent.
      if ((prepared.updateMode ?? "merge") === "fresh" && original === null) {
        fail(t("ui.writeback_backup_failed"));
        return;
      }
      await repo.updateNote(path, { status: "running" });
      await options.onStarted?.();
    } catch (error) {
      try {
        await this.settleRunning(repo, path, { status: note.status });
      } catch {
        /* Keep the startup error; the registered run still must be released. */
      }
      throw error;
    }
    const progress = this.startProgress(path, used.model);
    const changed = (): Error => new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    try {
      const context = await options.buildContext(note);
      const result = await this.ports.askModel(
        context,
        used.model,
        used.reasoning,
        signal,
        undefined,
        options.accepted,
        undefined,
        // No progress entry, no observer: one is not made up for the steer, it would change the stream mode.
        steerObserver(progress.observer, options.steer)
      );
      // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
      progress.end();
      options.accepted?.();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await this.settleRunning(repo, path, { status: note.status });
      // The status is back; this is the file the write-time check compares with (the backup is `original`).
      const raw = await this.snapshotRaw(original, path, options);
      const save = async (summary: string, draft: string): Promise<void> =>
        this.ports.mutate()(async () => {
          if (signal.aborted || prepared.viewChanged()) throw changed();
          if (await prepared.sourcesChanged()) throw changed();
          const { note: latest, content: expectedContent } = repo.readNoteSnapshot
            ? await repo.readNoteSnapshot(path, options.map())
            : { note: await repo.readNote(path, options.map()), content: undefined };
          // The late-result fence (the shared AI write gate): a topic locked while the AI ran gets nothing (its status is
          // already back); a Living Node card is read-only here; another note at the path or a changed topic is stale.
          const blocked = aiWriteGate({
            owned: true,
            aiLocked: latest.aiLocked === true,
            readOnly: isAiCard(latest),
            identity: { read: noteIdentity(note), now: noteIdentity(latest) },
            version: { read: `${note.status}\n${snapshot}`, now: `${latest.status}\n${noteSnapshot(latest)}` }
          });
          if (blocked.includes("ai_locked")) throw aiLockedError();
          if (blocked.includes("read_only")) throw new Error(t("ui.living_node_use_run_card"));
          if (blocked.length) throw changed();
          const mode: WritebackMode = prepared.updateMode ?? "merge";
          const noteLanguage = noteLanguageOf(outputLanguage);
          const references = visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language));
          let written: string;
          let issues: AiResult["formatIssues"];
          let record: WritebackRecord | undefined;
          if (mode === "top") {
            // New findings only; the old Detail stays as it is. No count check was made, so there is nothing to mark.
            issues = [];
            const composed = await this.composeWrite({
              mode,
              path,
              oldDetail: latest.detail,
              // Appended on top: the old Detail stays, so an image it has is not embedded again.
              aiDetail: intakeAiMarkdown(draft, { kind: "task-detail", seenImages: imageKeysIn(latest.detail) }),
              summary,
              template: detailTemplate,
              language: noteLanguage,
              signal,
              hooks: options,
              raw
            });
            if (!composed.ok) throw new Error(composed.message);
            written = composed.detail;
            record = composed.record;
          } else {
            // "AI suggested" later research does not add a sources section to a note that has none (the section list stays).
            const keepsSections =
              (context.aiSections === "follow" || context.aiSections === "general") &&
              !detailTemplate.sections.some(section => section.role === "sources");
            let canonicalOnly = "";
            // New AI text only (a line it starts with an inline tag would stop Obsidian's editor from parsing the note);
            // a full rewrite: only a repeat inside the new Detail is dropped.
            const aiDetail = intakeAiMarkdown(draft, {
              kind: "task-detail",
              compose: guarded => {
                canonicalOnly = canonicalDetail(guarded, noteLanguage, detailTemplate);
                // Links the parent's earlier research had and the rewrite dropped are kept (no AI call; part of the saved detail).
                // "Only the new content" does not read the old Detail, so nothing is carried there.
                return mode === "fresh" || keepsSections
                  ? canonicalOnly
                  : carryForwardSources(
                      canonicalOnly,
                      [latest.summary, latest.detail, latest.newFindings, latest.visualReferences],
                      [summary, canonicalOnly, references],
                      outputLanguage,
                      detailTemplate
                    );
              }
            });
            // An edited draft is checked again so the topic's format mark matches what is saved.
            issues =
              result.formatIssues && draft !== result.detail
                ? checkCounts(canonicalOnly, detailTemplate)
                : result.formatIssues;
            const composed = await this.composeWrite({
              mode,
              path,
              oldDetail: latest.detail,
              aiDetail,
              summary,
              template: detailTemplate,
              language: noteLanguage,
              signal,
              hooks: options,
              raw
            });
            if (!composed.ok) throw new Error(composed.message);
            written = composed.detail;
            record = composed.record;
          }
          const patch: NotePatch = {
            summary: neutralizeText(summary),
            detail: neutralizeText(written),
            visualReferences: neutralizeText(references),
            // The findings are cleared only when the model saw them (the rewrite folds them in); unsent ones stay.
            ...(options.findingsSent() ? { newFindings: "" } : {}),
            status: "completed",
            ...formatIssuesPatch(issues, language)
          };
          const writeOptions = { detailTemplate, newVisualReferences: true };
          if (signal.aborted || prepared.viewChanged()) throw changed();
          if (repo.updateNoteGuarded) {
            const outcome = await repo.updateNoteGuarded(path, patch, {
              ...writeOptions,
              expectedContent: raw?.started ?? expectedContent,
              authorize: () => !signal.aborted && !prepared.viewChanged()
            });
            if (outcome === "discarded") throw changed();
          } else await repo.updateNote(path, patch, writeOptions);
          const saved = await repo.readNote(path, options.map());
          await options.onWritten({ before: { ...latest, status: note.status }, after: saved });
          options.queueCharts?.({
            path,
            saved,
            context,
            detail: saved.detail,
            formatIssues: issues,
            model: used.model,
            language: outputLanguage,
            template: detailTemplate,
            ...(mode === "top" && record ? this.chartGuard(mode, record) : {})
          });
        });
      // The result is written directly (no draft review); a write that fails or finds the topic changed writes
      // nothing and is reported, without marking the parent topic as failed.
      try {
        await options.drafted(result, save, result.summary, result.detail, note);
      } catch (error) {
        if (isAiLockedError(error)) fail(t("ui.ai_locked_notice"));
        else if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          fail(t("ui.research_stopped_existing_content_was_preserved"));
        } else {
          console.error("VAM synthesis write", error);
          fail(this.ports.recordFailure(t("log.child_integration_failed"), error));
        }
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        await this.settleRunning(repo, path, { status: note.status });
        fail(t("ui.research_stopped_existing_content_was_preserved"));
      } else {
        console.error("Visual Agent Map child integration", error);
        await this.settleRunning(repo, path, { status: "error", lastError: failureReason(error) });
        fail(this.ports.recordFailure(t("log.child_integration_failed"), error));
      }
    } finally {
      progress.end();
      free();
      await options.onSettled?.();
    }
  }

  private async runSelection(path: string, options: SynthesizeSelectionStart): Promise<void> {
    const handle = this.begin(path, "synthesizeSelection");
    if (!handle) {
      options.refused();
      return;
    }
    const onStop = (): void => options.stop();
    handle.signal.addEventListener("abort", onStop, { once: true });
    const free = (): void => {
      handle.signal.removeEventListener("abort", onStop);
      handle.release();
    };
    try {
      await this.synthesizeSelection(options, free);
    } finally {
      free();
    }
  }

  private async synthesizeSelection(options: SynthesizeSelectionStart, free: () => void): Promise<void> {
    const aborted = (): DOMException => new DOMException("Aborted", "AbortError");
    const changed = (): Error => new Error(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
    let progress: { end: () => void } | undefined;
    try {
      const chosen = await options.model();
      const sources = await options.readSources();
      options.begin(sources);
      const taskProgress = options.startProgress(chosen.model);
      const context = await options.buildContext(sources);
      const ask = (): Promise<AiResult> =>
        this.ports.askModel(
          context,
          chosen.model,
          chosen.reasoning,
          options.signal,
          undefined,
          options.accepted,
          undefined,
          taskProgress.observer
        );
      if (options.step === "draft") {
        const draft = async (): Promise<void> => {
          try {
            const result = await ask();
            // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
            taskProgress.end();
            if (!options.current()) return;
            if (options.signal.aborted || options.mapChanged())
              throw new Error(t("ui.the_map_or_parent_topic_changed_while_ai_was_running_no_subt"));
            const latest = await options.readSources();
            // The shared AI write gate: changed sources, then Stop pressed while they were re-read; nothing is written.
            const blocked = aiWriteGate({
              owned: !options.signal.aborted,
              version: { read: options.recordedSources(), now: documentsSnapshot(latest.documents) }
            });
            if (blocked.includes("stale")) throw changed();
            if (blocked.includes("owner_changed")) throw aborted();
            if (options.closed()) throw changed();
            const mark = options.applying();
            await this.ports.mutate()(() => options.write(result));
            options.written(mark);
          } catch (error) {
            if (!options.current()) return;
            options.draftFailed(error);
          } finally {
            taskProgress.end();
          }
        };
        await draft();
        options.finished();
        return;
      }
      progress = taskProgress;
      const result = await ask();
      taskProgress.end();
      options.accepted();
      if (!options.current()) return;
      if (options.signal.aborted || options.mapChanged()) throw aborted();
      const latest = await options.readSources();
      if (documentsSnapshot(latest.documents) !== options.recordedSources()) throw changed();
      const angles = result.suggestions.slice(0, 2);
      if (!angles.length) options.noDirections();
      else options.found(angles);
    } catch (error) {
      options.fail(error);
    } finally {
      progress?.end();
      free();
      options.settled();
    }
  }

  private async settleRunning(
    repo: RunRepository,
    path: string,
    patch: Pick<NotePatch, "status" | "lastError">
  ): Promise<void> {
    if (repo.settleRunningNote) await repo.settleRunningNote(path, patch);
    else await repo.updateNote(path, patch);
  }

  /** What the chart step needs to keep a "top" write-back's old text: the diagrammed text must still hold it, byte for byte. */
  private chartGuard(mode: WritebackMode, record: WritebackRecord): Pick<QueuedCharts, "updateMode" | "preserve"> {
    return { updateMode: mode, preserve: charted => chartPreserves(record, charted) };
  }

  /** "fresh" only: reads the whole note file before the run changes any field; null when it cannot be read. */
  private async readOriginal(mode: WritebackMode, path: string, hooks: WritebackHooks): Promise<string | null> {
    if (mode !== "fresh" || !hooks.readRaw) return null;
    try {
      return await hooks.readRaw(path);
    } catch {
      return null;
    }
  }

  /** The file once the run has marked the topic running (the baseline the write-time check compares with). */
  private async snapshotRaw(original: string | null, path: string, hooks: WritebackHooks): Promise<RawSnapshot | null> {
    if (original === null || !hooks.readRaw) return null;
    try {
      return { original, started: await hooks.readRaw(path) };
    } catch {
      return null;
    }
  }

  /**
   * Builds the text to save for one of the three write-back ways. Runs inside the mutation queue after the stale fence.
   * `top`: pure insert, blocked when the old text would not come back. `fresh`: the whole note file is backed up first and
   * read again just before the write; anything that fails or differs means nothing is written (`message` says why).
   */
  private async composeWrite(input: {
    mode: WritebackMode;
    path: string;
    oldDetail: string;
    aiDetail: string;
    summary: string;
    template: DetailTemplate;
    language: NoteLanguage;
    signal: AbortSignal;
    hooks: WritebackHooks;
    /** "fresh" only: the note file as the run found it, and as it was once the run had marked it running. */
    raw?: RawSnapshot | null;
  }): Promise<
    { ok: true; detail: string; record: WritebackRecord } | { ok: false; message: string; discarded?: true }
  > {
    const { mode, path, signal, hooks, raw } = input;
    const base = {
      mode,
      oldDetail: input.oldDetail,
      aiDetail: input.aiDetail,
      summary: input.summary,
      template: input.template,
      language: input.language
    };
    const compose = this.ports.composeWriteback ?? composeWriteback;
    if (mode !== "fresh") {
      const composed = compose({ ...base, now: new Date() });
      return composed.ok ? composed : { ok: false, message: t("ui.writeback_top_failed") };
    }
    const stopped = { ok: false as const, message: t("ui.research_stopped_existing_content_was_preserved") };
    const failed = { ok: false as const, message: t("ui.writeback_backup_failed") };
    if (!hooks.backupNote || !hooks.readRaw || !raw) return failed;
    if (signal.aborted) return stopped;
    try {
      // The file must still be as the run left it before a backup is made; otherwise the result is outdated.
      if ((await hooks.readRaw(path)) !== raw.started)
        return {
          ok: false as const,
          message: t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"),
          discarded: true as const
        };
      // The backup is the file from before the run touched anything (status, stamp), byte for byte.
      const backup = await hooks.backupNote(path, raw.original);
      if (!backup.ok) return failed;
      const composed = compose({ ...base, now: new Date(), backupPath: backup.path });
      if (!composed.ok) return failed;
      // The stale fence has shown the topic's content is unchanged; the file itself must also be as the run left it.
      if ((await hooks.readRaw(path)) !== raw.started) return failed;
      if (signal.aborted) return stopped;
      return composed;
    } catch {
      return failed;
    }
  }

  /** Reads the note, resolves the model and style and builds the request; null (after telling the entry) when the topic has no task. */
  private async researchPrelude(
    path: string,
    options: ResearchStart,
    givenStyle: RunStyle | undefined,
    overrides: Partial<TaskContext>
  ): Promise<ResearchPrelude | null> {
    const repo = this.ports.repository()!;
    const note = await repo.readNote(path, options.map);
    const used = options.runOnce?.model.trim()
      ? await this.ports.resolveModel(path, options.map, options.runOnce)
      : { model: note.model, reasoning: note.reasoning };
    if (!(overrides.task ?? note.prompt)) {
      const message = t("ui.enter_a_question_or_task_for_ai_first");
      if (options.failed) options.failed(message);
      else options.notify?.(message);
      return null;
    }
    const outputLanguage = overrides.outputLanguage ?? this.ports.settings().language;
    let runStyle =
      givenStyle ??
      (options.resolveStyle
        ? await options.resolveStyle(outputLanguage)
        : this.ports.runStyle({ note, outputLanguage }));
    // The note's sections decide an "AI suggested" run, and the Detail can change between the caller's resolution and
    // here: resolve again from the Detail this run sends. A whole rewrite ("fresh" is set only by it) is not held to the
    // note's sections: the AI decides them again.
    const rewrite = overrides.updateMode === "fresh";
    if (
      runStyle.aiSections &&
      (runStyle.aiSections.forDetail !== note.detail || (rewrite && runStyle.aiSections.mode !== "decide"))
    )
      runStyle = this.ports.runStyle({ note, outputLanguage, ...(rewrite ? { rewrite } : {}) });
    const detailTemplate = runStyle.template;
    const anchorText = options.anchorContext?.(outputLanguage) || undefined;
    const context: TaskContext = withThinkingOrigin(
      {
        title: note.title,
        summary: summaryForPrompt(note.summary, outputLanguage),
        rules: "",
        detail: note.detail,
        task: note.prompt,
        ancestors: (await options.ancestors?.(outputLanguage)) ?? "",
        userTexts: options.userTexts?.() ?? "",
        // Only when there is text: a topic without anchors keeps the exact request it had before.
        ...(anchorText ? { anchorContext: anchorText } : {}),
        workingFindings: note.newFindings,
        sourceContext: "",
        mode: "task",
        researchMode: note.researchMode,
        researchDepth: "normal",
        visualMode: note.visualMode,
        ...(runStyle.toneText ? { toneText: runStyle.toneText } : {}),
        ...(options.usageMapPath ? { usageMapPath: options.usageMapPath } : {}),
        ...overrides,
        detailTemplate,
        ...runStyle.contextFields,
        // A run that asks for its own update mode (a whole rewrite from the map chat) wins over the style's.
        updateMode: overrides.updateMode ?? runStyle.updateMode,
        addCharts: overrides.addCharts ?? true
      },
      note
    );
    const styleLabel =
      runStyle.recipe.source !== "kind" || runStyle.recipe.ref !== "builtin:general"
        ? runStyleLabelText(runStyle.label, this.ports.settings().language)
        : undefined;
    return { note, used, context, styleLabel };
  }

  private async startResearch(path: string, kind: "research", options: ResearchStart): Promise<AgentTaskHandle | null> {
    if (this.disposed) return null;
    const { runStyle: givenStyle, ...overrides } = options.request ?? {};
    const settings = (): ReturnType<TopicRunPorts["settings"]> => this.ports.settings();
    if (this.running.has(path)) {
      options.failed?.(t("ui.ai_running_ai"));
      return null;
    }
    // Registered before the first await: a second click on the topic is refused while the note is still being read.
    const handle = this.begin(path, kind);
    if (!handle) return null;
    const controller = this.controllers.get(path)!;
    let prelude: ResearchPrelude | null;
    const repo = this.ports.repository()!;
    try {
      prelude = await this.researchPrelude(path, options, givenStyle, overrides);
    } catch (error) {
      handle.release();
      throw error;
    }
    if (!prelude) {
      handle.release();
      return null;
    }
    const { note, used, context, styleLabel } = prelude;
    if (isAiCard(note)) {
      handle.release();
      if (options.failed) options.failed(t("ui.living_node_use_run_card"));
      else options.notify?.(t("ui.living_node_use_run_card"));
      return null;
    }
    // AI lock: a locked topic is refused before anything is written or any AI call is made.
    if (note.aiLocked) {
      handle.release();
      if (options.failed) options.failed(t("ui.ai_locked_notice"));
      else options.notify?.(t("ui.ai_locked_notice"));
      return null;
    }
    const language = settings().language;
    this.pendingSuggestions.delete(path);
    // A diagram job still running for the previous result of this note must not land on the new run.
    this.abortCharts(path);
    const activeTasks = this.ports.activeTasks();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides.signal?.aborted) controller.abort();
    else overrides.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    activeTasks.set(path, controller);
    // Research replaces any previous progress; other requests leave an existing chart entry alone.
    const progress = this.startProgress(path, used.model, styleLabel, true);
    const observer = progress.observer ?? {};
    const releaseRun = (): void => {
      overrides.signal?.removeEventListener("abort", abortFromTaskModal);
      if (activeTasks.get(path) === controller) activeTasks.delete(path);
      handle.release();
    };
    const fail = (message: string): void => {
      if (options.failed) options.failed(message);
      else options.notify?.(message);
    };
    const releaseStartup = (): void => {
      progress.end();
      releaseRun();
    };
    let startupStatusAttempted = false;
    let raw: RawSnapshot | null = null;
    try {
      startupStatusAttempted = true;
      const original = await this.readOriginal(context.updateMode ?? "merge", path, options);
      // A "fresh" write needs the file for its backup: when it cannot be read, stop before any AI call is spent.
      if ((context.updateMode ?? "merge") === "fresh" && original === null) {
        fail(t("ui.writeback_backup_failed"));
        releaseStartup();
        return null;
      }
      await repo.updateNote(path, { status: "running" });
      await options.onStarted?.();
      raw = await this.snapshotRaw(original, path, options);
      if (controller.signal.aborted) {
        try {
          await this.settleRunning(repo, path, { status: note.status });
        } finally {
          releaseStartup();
        }
        return null;
      }
    } catch (error) {
      try {
        if (startupStatusAttempted) await this.settleRunning(repo, path, { status: note.status });
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
      options.accepted?.();
    };
    const exchanges = (): RunExchanges | null | undefined =>
      settings().aiExchangeLoggingEnabled ? this.ports.exchanges() : undefined;
    const completion = this.ports
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
        steerObserver(observer, options.steer)
      )
      .then(result =>
        this.ports.mutate()(async () => {
          // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
          progress.end();
          const { note: latest, content: expectedContent } = repo.readNoteSnapshot
            ? await repo.readNoteSnapshot(path, options.map)
            : { note: await repo.readNote(path, options.map), content: undefined };
          // The late-result fence (the shared AI write gate): a topic locked while the AI ran gets nothing but its status back.
          const blocked = aiWriteGate({
            owned: !controller.signal.aborted,
            aiLocked: latest.aiLocked === true,
            readOnly: isAiCard(latest),
            identity: { read: noteIdentity(note), now: noteIdentity(latest) },
            version: { read: researchVersion(note, "running"), now: researchVersion(latest, latest.status) }
          });
          const locked = blocked.includes("ai_locked");
          const stale = blocked.includes("stale") || blocked.includes("identity_changed");
          if (blocked.length) {
            await this.settleRunning(repo, path, { status: note.status });
            if (exchangeId)
              exchanges()?.failed(
                exchangeId,
                t(stale && !locked ? "log.stale_result_not_written" : "log.stopped_result_not_written")
              );
            if (locked) fail(t("ui.ai_locked_notice"));
            else if (blocked.includes("read_only")) fail(t("ui.living_node_use_run_card"));
            else if (stale) {
              options.pipeline?.onDiscarded?.();
              fail(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
            }
            return;
          }
          // "AI suggested" first research: the sections the AI wrote are the template of everything written below (the
          // canonical detail, the note update, the chart job). Without the flag this is the run's own context.
          const effective = result.decidedTemplate ?? context.detailTemplate;
          const writeContext: TaskContext =
            context.aiSections === "decide"
              ? { ...context, detailTemplate: effective, aiSections: undefined }
              : context;
          if (result.aiSectionsFallback) options.notify?.(t("ui.note_style_ai_sections_invalid"));
          // Write-back comes after the stale fence: the old Detail is `latest.detail`, which equals the one the run started with.
          const mode: WritebackMode = writeContext.updateMode ?? "merge";
          const writeLanguage = noteLanguageOf(context.outputLanguage ?? settings().language);
          // top gets the raw reply (new findings only); merge and fresh get the canonical Detail.
          // Images: "top" keeps the old Detail, so its images count as seen; a full rewrite replaces it, so only repeats
          // inside the new Detail are dropped.
          const aiDetail = intakeAiMarkdown(result.detail, {
            kind: "task-detail",
            seenImages: mode === "top" ? imageKeysIn(latest.detail) : undefined,
            compose: fresh => {
              let composed =
                mode === "top" ? fresh : canonicalDetail(fresh, writeLanguage, writeContext.detailTemplate);
              // "AI suggested" later research (or a note whose sections cannot be followed): the numbers and links the rewrite
              // dropped are put back from the Detail this run started from; the write is never refused for it.
              if (
                (context.aiSections === "follow" || context.aiSections === "general") &&
                mode === "merge" &&
                latest.detail.trim()
              ) {
                const kept = keepDroppedContent({
                  oldDetail: latest.detail,
                  newDetail: composed,
                  summary: result.summary,
                  references: visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language)),
                  template: writeContext.detailTemplate ?? standardTemplate(writeLanguage),
                  language: writeLanguage
                });
                composed = kept.detail;
                if (kept.restored > 0) options.notify?.(t("ui.note_style_restored_0", kept.restored));
              }
              return composed;
            }
          });
          const composed = await this.composeWrite({
            mode,
            path,
            oldDetail: latest.detail,
            aiDetail,
            summary: result.summary,
            template: writeContext.detailTemplate ?? standardTemplate(writeLanguage),
            language: writeLanguage,
            signal: controller.signal,
            hooks: options,
            raw
          });
          if (!composed.ok) {
            await this.settleRunning(repo, path, { status: note.status });
            if (exchangeId) exchanges()?.failed(exchangeId, composed.message);
            if (composed.discarded) options.pipeline?.onDiscarded?.();
            fail(composed.message);
            return;
          }
          // Model text never makes a hidden callout (the stylesheet hides that type vault-wide); the pipeline writes its own after this.
          const patch: NotePatch = {
            ...(options.pipeline?.keepSummary ? {} : { summary: neutralizeText(result.summary) }),
            detail: neutralizeText(composed.detail),
            visualReferences: neutralizeText(
              visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language))
            ),
            newFindings: "",
            status: "completed",
            // The topic remembers the mode of its latest research (Quick is stored as local).
            ...(context.researchMode ? { researchMode: context.researchMode } : {}),
            // A Standard research that retrieved from the web records when (only that key; the URLs are not stored).
            ...(result.retrievals ? { researchRetrievedAt: new Date().toISOString() } : {}),
            ...(mode === "top" ? { detailFormatIssues: [] } : formatIssuesPatch(result.formatIssues, language))
          };
          const writeOptions = { detailTemplate: writeContext.detailTemplate, newVisualReferences: true };
          const guard = options.pipeline;
          // A refusal by the pipeline's own `finalize` (no chapter text, unsafe body) is not a stale topic: it is logged as what it is.
          let refused = false;
          const markDiscarded = (message: string) => {
            if (exchangeId) exchanges()?.failed(exchangeId, message);
          };
          if (guard) {
            // The pipeline's write: the file must still be the text the run left, the run must still be current, and the text
            // is cleaned inside the write. Without the guarded write nothing is saved (never the unguarded path).
            const outcome = repo.updateNoteGuarded
              ? await repo.updateNoteGuarded(path, patch, {
                  ...writeOptions,
                  expectedContent: raw?.started ?? expectedContent,
                  authorize: current => !controller.signal.aborted && guard.authorize(current),
                  finalize: guard.finalize
                    ? (content: string) => {
                        const final = guard.finalize(content);
                        if (final === null) refused = true;
                        return final;
                      }
                    : guard.finalize
                })
              : "discarded";
            if (outcome === "discarded") {
              await this.settleRunning(repo, path, { status: note.status });
              markDiscarded(t(refused ? "log.result_refused_not_written" : "log.stale_result_not_written"));
              options.pipeline?.onDiscarded?.();
              fail(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
              return;
            }
          } else {
            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
            if (repo.updateNoteGuarded) {
              const outcome = await repo.updateNoteGuarded(path, patch, {
                ...writeOptions,
                expectedContent: raw?.started ?? expectedContent,
                authorize: () => !controller.signal.aborted
              });
              if (outcome === "discarded") {
                await this.settleRunning(repo, path, { status: note.status });
                const stopped = controller.signal.aborted;
                markDiscarded(t(stopped ? "log.stopped_result_not_written" : "log.stale_result_not_written"));
                fail(
                  t(
                    stopped
                      ? "ui.research_stopped_existing_content_was_preserved"
                      : "ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"
                  )
                );
                return;
              }
            } else await repo.updateNote(path, patch, writeOptions);
          }
          const saved = await repo.readNote(path, options.map);
          options.onWritten?.({ before: { ...latest, status: note.status }, after: saved });
          if (exchangeId) exchanges()?.completed(exchangeId);
          this.ports.clearOtherHistory(options.origin);
          options.queueCharts?.({
            path,
            saved,
            context: writeContext,
            detail: saved.detail,
            formatIssues: mode === "top" ? [] : result.formatIssues,
            model: used.model,
            language: context.outputLanguage ?? settings().language,
            template: writeContext.detailTemplate,
            ...(mode === "top" ? this.chartGuard(mode, composed.record) : {})
          });
          options.done?.(result);
        })
      )
      .catch(error =>
        this.ports.mutate()(async () => {
          progress.end();
          if (options.pipeline && isBudgetExhausted(error)) {
            // Not a failure of the note: it keeps its old status and gets no error text.
            await this.settleRunning(repo, path, { status: note.status });
            options.pipeline.onBudgetExhausted();
            return;
          }
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            await this.settleRunning(repo, path, { status: note.status });
            fail(t("ui.research_stopped_existing_content_was_preserved"));
            return;
          }
          console.error("Visual Agent Map AI task", error);
          if (
            exchangeId &&
            exchanges()
              ?.getEntries()
              .find(item => item.id === exchangeId)?.status === "parsed"
          )
            exchanges()?.failed(
              exchangeId,
              t("log.topic_write_failed_0", error instanceof Error ? error.message : String(error))
            );
          await this.settleRunning(repo, path, {
            status: options.pipeline?.keepStatusOnFailure ? note.status : "error",
            lastError: failureReason(error)
          });
          fail(this.ports.recordFailure(t("log.ai_task_failed"), error));
        })
      )
      .finally(() => {
        progress.end();
        releaseRun();
        this.ports.refreshViews();
      })
      .catch(() => {});
    const accepted = await Promise.race([acceptedPromise, completion.then(() => false)]);
    if (!accepted) {
      await completion;
      return null;
    }
    return { finished: completion };
  }

  /** The current store of suggestions awaiting a decision (onload swaps the plugin's for the persisted one). */
  get pendingSuggestions(): Map<string, Suggestion[]> {
    return this.ports.pendingSuggestions();
  }

  isRunning(path: string): boolean {
    return this.controllers.has(path);
  }

  /** The kind of the run in flight on the topic, if this module started one. */
  runKind(path: string): TopicRunKind | undefined {
    return this.kinds.get(path);
  }

  /** Whether the topic has a run in flight, or another path (chat expansion, a reload leftover) holds it in the running set. */
  isBusy(path: string): boolean {
    return this.running.has(path);
  }

  /** Whether any stoppable AI task (shared registry: AiCalls, shallow expansion, selection synthesis) is registered for the path. */
  hasTask(path: string): boolean {
    return this.ports.activeTasks().has(path);
  }

  taskController(path: string): AbortController | undefined {
    return this.ports.activeTasks().get(path);
  }

  /** Aborts the registered task of the path, if any. */
  stopTask(path: string): void {
    this.ports.activeTasks().get(path)?.abort();
  }

  /** Registers the stop handle of a single topic's integration (startTopicSynthesis); it is released only when still the same one. */
  registerTask(path: string, controller: AbortController): void {
    this.ports.activeTasks().set(path, controller);
  }

  /** Releases the stop handle, only when it is still the one registered. */
  releaseTask(path: string, controller: AbortController): void {
    const tasks = this.ports.activeTasks();
    if (tasks.get(path) === controller) tasks.delete(path);
  }

  /** The synthesis state of one view, created on the first read. The view reads it and tests may write it. */
  syntheses(owner: object): SynthesisState {
    let state = this.synthesisStates.get(owner);
    if (!state) {
      state = { selection: null, selectionStarting: false, topics: new Map() };
      this.synthesisStates.set(owner, state);
    }
    return state;
  }

  /**
   * One step of a single topic's integration: the AI's suggested directions (`direction === null`), then the draft.
   * The task is kept for the card until it is written or discarded; the stop handle is registered for the topic.
   */
  async startTopicSynthesis(owner: object, path: string, input: TopicSynthesisStart): Promise<void> {
    const { options, direction, failed, accepted, observer } = input;
    const topics = this.syntheses(owner).topics;
    const existing = topics.get(path);
    const step = direction === null ? "directions" : "draft";
    if (this.isBusy(path) || this.hasTask(path) || existing?.state === "running") {
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
      if (existing && (existing.mapPath !== input.mapPath || existing.mapId !== input.mapId)) {
        failed(t("ui.the_topic_changed_the_synthesis_draft_was_not_saved"));
        return;
      }
    }
    const controller = new AbortController();
    const modalSignal = options.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    // `steer` belongs to this run only: a task kept for the next step must not carry it (and the next step brings its own).
    const stored = { ...options, signal: undefined, onProgress: undefined, steer: undefined };
    const task: TopicSynthesisTask =
      step === "draft" &&
      existing?.directions.length &&
      (existing.state === "directions" || options.continuesDirections)
        ? existing
        : {
            mapPath: input.mapPath,
            mapId: input.mapId,
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
    topics.set(path, task);
    this.registerTask(path, controller);
    const runOptions: TaskOptions = {
      ...(step === "draft"
        ? { ...task.options, requirements: options.requirements || task.options.requirements }
        : options),
      // The model of this step is the dialog's choice now, not the one the first step was started with.
      runOnce: options.runOnce,
      steer: options.steer,
      signal: controller.signal,
      onProgress: message => {
        task.progress = message;
        options.onProgress?.(message);
        if (topics.get(path) === task) input.changed();
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
      if (topics.get(path) === task) {
        if (controller.signal.aborted && observer?.isOpen()) {
          // Stopped from the open dialog: nothing was produced, so leave no badge behind. A draft that was stopped
          // returns to its directions; a directions request that was stopped just goes away.
          if (step === "draft" && task.directions.length) task.state = "directions";
          else topics.delete(path);
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
        await input.directions(
          runOptions,
          items => {
            // A result that arrives after Stop or after the task was replaced is dropped.
            if (controller.signal.aborted || topics.get(path) !== task) return;
            outcome = "found";
            task.state = "directions";
            task.directions = items;
            // Shown in the dialog that started the step.
            if (observer?.isOpen() && observer.directions) observer.directions(items);
          },
          fail,
          markAccepted
        );
      else
        await input.draft(
          runOptions,
          direction ?? "",
          async (_result, save, summary, detail) => {
            // Stop, close or a replaced task before the write: nothing is written.
            if (controller.signal.aborted || topics.get(path) !== task) return;
            const previous = input.undoMark();
            await save(summary, detail);
            outcome = "written";
            if (topics.get(path) === task) topics.delete(path);
            input.written(previous);
            if (observer?.isOpen()) observer.written?.();
            observer?.onWritten?.();
          },
          fail,
          markAccepted
        );
      if (!outcome) fail(t("ui.ai_task_cancelled"));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      this.releaseTask(path, controller);
      input.changed();
    }
  }

  /** Stops the topic's running integration through its own controller (a task that is not running has nothing to stop). */
  stopSynthesis(owner: object, path: string): void {
    const task = this.syntheses(owner).topics.get(path);
    if (task?.state === "running") task.controller.abort();
  }

  /** Forgets the topic's integration unless it is running; true when it was removed. */
  discardSynthesis(owner: object, path: string): boolean {
    const topics = this.syntheses(owner).topics;
    const task = topics.get(path);
    if (!task || task.state === "running") return false;
    topics.delete(path);
    return true;
  }

  /** The view closed: its running integrations are stopped and every entry goes away. */
  dropSyntheses(owner: object): void {
    const topics = this.syntheses(owner).topics;
    for (const task of topics.values()) if (task.state === "running") task.controller.abort();
    topics.clear();
  }

  /**
   * One step of multi-select synthesis: the AI's suggested directions (`direction === null`), then the draft. Both
   * report to the open dialog through `observer`; once it is closed the run carries on and the selection bar shows it.
   * The view has already checked the map, the selection size and the AI lock.
   */
  async startSelectionSynthesis(owner: object, input: SelectionSynthesisStart): Promise<void> {
    const { sources, options, direction, failed, accepted, observer, errorSink } = input;
    const state = this.syntheses(owner);
    this.selectionChanged.set(owner, input.changed);
    const existing = state.selection && state.selection.mapPath === input.mapPath ? state.selection : null;
    const step = direction === null ? "directions" : "draft";
    if (existing?.state === "running" || state.selectionStarting) {
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
    state.selectionStarting = true;
    const controller = new AbortController();
    const modalSignal = options.signal;
    const abortBeforeAcceptance = (): void => controller.abort();
    if (modalSignal?.aborted) controller.abort();
    else modalSignal?.addEventListener("abort", abortBeforeAcceptance, { once: true });
    // Shared by settled and refused, so a start the registry refuses does not keep this view blocked or leak the listener.
    const releaseStarting = (): void => {
      state.selectionStarting = false;
      modalSignal?.removeEventListener("abort", abortBeforeAcceptance);
      input.changed();
    };
    let own: SelectionSynthesisTask | undefined;
    const runOptions: TaskOptions = {
      ...base,
      requirements: options.requirements || base.requirements,
      signal: controller.signal,
      onProgress: message => {
        if (state.selection) state.selection.progress = message;
        options.onProgress?.(message);
        input.changed();
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
      const task = state.selection;
      if (aborted && observer?.isOpen()) {
        // Stopped from the open dialog: nothing was produced, so no badge stays behind.
        if (own && state.selection === own) state.selection = null;
        input.changed();
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
        input.changed();
      }
      if (errorSink && !aborted) {
        // The thin entry rethrows the original error to its caller instead of logging a user message.
        errorSink(error);
        failed(error instanceof Error ? error.message : String(error));
        return;
      }
      failed(
        aborted
          ? t("ui.research_stopped_existing_content_was_preserved")
          : this.ports.recordFailure(
              t(step === "draft" ? "log.child_integration_failed" : "log.integration_directions_failed"),
              error
            )
      );
    };
    let task: SelectionSynthesisTask | undefined;
    let modelChoice: ModelChoice | undefined;
    const mapPath = input.mapPath,
      mapId = input.mapId;
    const summaryMode = base.synthesisContent === "summary" ? "summary" : "strong";
    const isDraft = step === "draft";
    await this.start(mapPath, "synthesizeSelection", {
      step,
      signal: controller.signal,
      stop: () => controller.abort(),
      refused: () => {
        releaseStarting();
        failed(t("ui.ai_running_ai"));
      },
      model: async () => {
        // Sources still being researched write back after the read and would fail the sources check: wait for them.
        await this.whenIdle(
          sources.map(source => source.path),
          controller.signal
        );
        return (modelChoice = await input.model());
      },
      readSources: () => input.readSources(summaryMode, runOptions.outputLanguage),
      begin: group => {
        task = {
          title,
          goal: isDraft ? (direction ?? "") : "",
          rules: "",
          sources,
          options: { ...runOptions, signal: undefined, onProgress: undefined },
          mapPath,
          mapId,
          sourceContent: documentsSnapshot(group.documents),
          controller,
          state: "running",
          step: isDraft ? "draft" : "directions",
          directions: isDraft && continuing && existing ? existing.directions : [],
          progress: "",
          model: modelChoice!.model,
          reasoning: modelChoice!.reasoning
        };
        state.selection = task;
        if (!isDraft) own = task;
        input.changed();
      },
      startProgress: model => input.startProgress(model),
      buildContext: group => {
        const current = task!;
        return input.buildContext(group, current, runOptions, message => {
          if (state.selection !== current) return;
          current.progress = message;
          runOptions.onProgress?.(message);
          input.changed();
        });
      },
      accepted: markAccepted,
      current: () => state.selection === task,
      mapChanged: () => input.mapChanged(mapPath, mapId),
      recordedSources: () => task!.sourceContent,
      found: angles => {
        const waiting = task!;
        waiting.state = "directions";
        waiting.directions = angles;
        input.changed();
        if (observer?.isOpen() && observer.directions) observer.directions(angles);
        else input.offerDirections(waiting);
      },
      noDirections: () => {
        state.selection = null;
        input.changed();
        failed(t("ui.ai_did_not_suggest_a_synthesis_direction_please_retry"));
      },
      closed: () => input.closed(),
      applying: () => {
        task!.state = "applying";
        input.changed();
        return input.undoMark();
      },
      write: result => input.write(result, task!, modelChoice!.model),
      written: previous => {
        input.written(previous, task!);
        if (observer?.isOpen()) observer.written?.();
      },
      draftFailed: error => {
        const draftTask = task!;
        if (controller.signal.aborted && observer?.isOpen()) {
          // Stopped from the open dialog: nothing was produced, so no badge stays behind.
          if (draftTask.directions.length) draftTask.state = "directions";
          else state.selection = null;
          input.changed();
          throw error;
        }
        draftTask.state = controller.signal.aborted ? "cancelled" : "failed";
        draftTask.progress = controller.signal.aborted
          ? t("ui.research_stopped_existing_content_was_preserved")
          : error instanceof Error
            ? error.message
            : String(error);
        input.changed();
        if (!controller.signal.aborted) throw error;
      },
      finished: markAccepted,
      fail,
      settled: releaseStarting
    });
  }

  /** The selection bar's Stop: aborts the running task's controller and marks it cancelled. */
  stopSelection(owner: object): void {
    const task = this.syntheses(owner).selection;
    if (!task) return;
    task.controller.abort();
    task.state = "cancelled";
    this.selectionChanged.get(owner)?.();
  }

  /** Forgets the selection synthesis unless it is running; true when it was removed. */
  discardSelection(owner: object): boolean {
    const state = this.syntheses(owner);
    const task = state.selection;
    if (!task || task.state === "running") return false;
    state.selection = null;
    return true;
  }

  /** The synthesis was written: its task is no longer shown. */
  clearSelection(owner: object): void {
    this.syntheses(owner).selection = null;
  }

  pending(path: string): Suggestion[] | undefined {
    return this.pendingSuggestions.get(path);
  }

  dropPending(path: string): void {
    this.pendingSuggestions.delete(path);
  }

  /** Persists the pending store when it is the persisted one (a plain Map has nothing to flush). */
  async flushPending(): Promise<void> {
    await (this.pendingSuggestions as { flush?: () => Promise<void> }).flush?.();
  }

  stop(path: string): void {
    this.controllers.get(path)?.abort();
  }

  stopAll(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.abortCharts();
  }

  get chartJobs(): ReadonlyMap<string, AbortController> {
    return this.charts;
  }

  /** Aborts the background chart step of one note (a new run on that note replaces it), or of every note. */
  abortCharts(path?: string): void {
    for (const [key, controller] of [...this.charts])
      if (path === undefined || key === path) {
        controller.abort();
        this.charts.delete(key);
        this.wakeIdleWaiters();
        this.endChartProgress(key);
        // A queued job never starts; a running one frees its slot when it settles.
        const queued = this.chartQueue.findIndex(item => item.controller === controller);
        if (queued >= 0) this.chartQueue.splice(queued, 1);
      }
  }

  private endChartProgress(path: string): void {
    const id = this.chartProgressIds.get(path);
    if (id === undefined) return;
    this.chartProgressIds.delete(path);
    this.ports.progress().end(path, id);
  }

  private pumpChartQueue(): void {
    while (this.chartRunning < CHART_JOB_LIMIT && this.chartQueue.length) {
      this.chartRunning++;
      this.chartQueue.shift()!.start();
    }
  }

  /**
   * Runs the chart step in the background for a note that was just written. It never blocks or fails the research:
   * a failure, Stop, a stale note or unload leaves the note as written (the chart exchange is marked failed with the
   * reason). `apply` runs in the mutation queue and returns false when the note no longer equals its snapshot at
   * write time or is running again; only then are the diagrams not applied.
   */
  addChartsAfterWrite(job: ChartJob): void {
    // After unload the repository is released: no chart job may start.
    if (this.ports.repository()?.isDisposed?.()) return;
    if (!this.ports.aiTasks().chartEligible(job.context) || !job.detail.trim()) return;
    this.abortCharts(job.path);
    const controller = new AbortController();
    this.charts.set(job.path, controller);
    const progressId = `charts-${++this.chartProgressSeq}`;
    this.chartProgressIds.set(job.path, progressId);
    this.ports.progress().begin(job.path, progressId, Date.now(), job.model);
    this.ports.progress().stage(job.path, progressId, "charts", Date.now());
    let exchangeId = "";
    const run = async (): Promise<void> => {
      try {
        const detail = await this.ports.aiTasks().chartDetail({
          input: job.context,
          detail: job.detail,
          countIssues: job.countIssues,
          model: job.model,
          signal: controller.signal,
          onExchange: id => {
            exchangeId = id;
          }
        });
        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (detail === job.detail) return;
        let applied = false;
        await this.ports.mutate()(async () => {
          applied = !controller.signal.aborted && (await job.apply(detail));
        });
        if (!applied) this.ports.aiTasks().failExchange(exchangeId, t("log.chart_stale_not_applied"));
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
          this.ports.aiTasks().failExchange(exchangeId, t("log.chart_stopped_not_applied"));
        else {
          console.warn("Visual Agent Map chart step", error);
          this.ports.aiTasks().failExchange(exchangeId, t("log.chart_not_added_0", "apply_error"));
        }
      } finally {
        if (this.charts.get(job.path) === controller) {
          this.charts.delete(job.path);
          this.wakeIdleWaiters();
        }
        if (this.chartProgressIds.get(job.path) === progressId) this.endChartProgress(job.path);
        this.chartRunning--;
        this.pumpChartQueue();
      }
    };
    this.chartQueue.push({
      controller,
      start: () => {
        void run();
      }
    });
    this.pumpChartQueue();
  }

  /** Stops every run and refuses new ones. */
  dispose(): void {
    this.disposed = true;
    this.stopAll();
  }
}
