/**
 * The plugin-level registry of topic AI runs: which topics have a run in flight and the controller that stops each.
 * It imports neither obsidian nor the view; everything it needs from the plugin comes through lazy ports, because the
 * plugin replaces some of those objects after construction.
 */
import { noteLanguageOf, t, type ContentLanguage, type NoteLanguage, type UiLanguage } from "../../i18n";
import type { AiResult, ReasoningLevel, Suggestion, TaskContext } from "../../ai/types";
import type { DetailTemplate } from "../../ai/detail-templates";
import type { ReferenceGroup } from "../../ai/reference-materials";
import type { ResearchObserver, ResearchPreviewFields, ResearchStageName } from "../../ai/research-observer";
import { canonicalDetail, visualReferencesMarkdown } from "../../ai/result-utils";
import { checkCounts, standardTemplate } from "../../ai/detail-templates";
import { carryForwardSources } from "../../core/steps/task/carry-sources";
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
import type { MapDocument } from "../../map-model";
import type { AgentTaskHandle, RunOnceModel } from "./modals";
import { withThinkingOrigin } from "./thinking-origin";
import { formatIssuesPatch, originBaseline, summaryForPrompt } from "./note-write-helpers";

/** Chart steps that may run at once; further jobs wait in a first-in-first-out queue. */
export const CHART_JOB_LIMIT = 3;

export type TopicRunKind =
  "research" | "proposeChildren" | "integrateDirection" | "integrateChildren" | "synthesizeSelection";

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
  updateNote(path: string, patch: NotePatch, options?: { detailTemplate?: DetailTemplate }): Promise<void>;
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
  runStyle(input: { note: Note; outputLanguage: ContentLanguage }): RunStyle;
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
  /** Runs after the status was set to running (the view reloads and redraws). */
  onStarted?: () => Promise<void>;
  /** The note before and after the write, for the starting view's undo. */
  onWritten?: (change: { before: Note; after: Note }) => void;
  /** Queues the background chart step for the note that was just written. */
  queueCharts?: (job: QueuedCharts) => void;
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
}

/**
 * What a selection-synthesis run needs from the entry that starts it (the view). The run belongs to a map, not to one
 * topic: it is registered under the map's path like any other run, so Stop, stopAll and dispose reach it through
 * `stop`. The view keeps the task state it shows.
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
  private disposed = false;
  /** Background chart steps (running and queued), keyed by note path: one per path, at most {@link CHART_JOB_LIMIT} run at a time. */
  private readonly charts = new Map<string, AbortController>();
  /** The progress entry each background chart job owns (the research run's own entry ends when the note is written). */
  private readonly chartProgressIds = new Map<string, string>();
  private chartProgressSeq = 0;
  /** Jobs waiting for a free slot, first in first out. */
  private readonly chartQueue: Array<{ controller: AbortController; start: () => void }> = [];
  private chartRunning = 0;

  constructor(readonly ports: TopicRunPorts) {}

  /**
   * Registers a run for the topic. Returns null when the topic already has one or the module is disposed. Every run
   * calls this synchronously, before its first await, so a second click on the same topic is refused.
   */
  begin(path: string, kind: TopicRunKind): TopicRunHandle | null {
    if (this.disposed || this.controllers.has(path)) return null;
    const controller = new AbortController();
    this.controllers.set(path, controller);
    this.running.add(path);
    return {
      path,
      kind,
      signal: controller.signal,
      release: () => {
        if (this.controllers.get(path) !== controller) return;
        this.controllers.delete(path);
        this.running.delete(path);
      }
    };
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

  /** Stage, seconds and the unsaved preview of one request; an entry the topic already has (a chart step) is left alone. */
  private startProgress(path: string, model: string): { observer?: ResearchObserver; end: () => void } {
    const progress = this.ports.progress() as (RunProgress & { get?(path: string): unknown }) | undefined;
    if (!progress || progress.get?.(path)) return { end: () => {} };
    let attempt = "starting";
    progress.begin(path, attempt, Date.now(), model);
    return {
      observer: {
        onAttempt: id => {
          attempt = id;
          progress.newAttempt(path, id, Date.now());
        },
        onStage: (id, stage, query) => progress.stage(path, id, stage, Date.now(), query),
        onPreview: (id, fields) => progress.preview(path, id, fields ?? {})
      },
      end: () => progress.end(path, attempt)
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
      await repo.updateNote(path, { status: "running" });
      await options.onStarted?.();
    } catch (error) {
      try {
        await repo.updateNote(path, { status: note.status });
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
        progress.observer
      );
      // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
      progress.end();
      options.accepted?.();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      await repo.updateNote(path, { status: note.status });
      // The status is back; this is the file the write-time check compares with (the backup is `original`).
      const raw = await this.snapshotRaw(original, path, options);
      const save = async (summary: string, detail: string): Promise<void> =>
        this.ports.mutate()(async () => {
          if (signal.aborted || prepared.viewChanged()) throw changed();
          if (await prepared.sourcesChanged()) throw changed();
          const latest = await repo.readNote(path, options.map());
          if (noteSnapshot(latest) !== snapshot) throw changed();
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
              aiDetail: detail,
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
            const canonicalOnly = canonicalDetail(detail, noteLanguage, detailTemplate);
            // An edited draft is checked again so the topic's format mark matches what is saved.
            issues =
              result.formatIssues && detail !== result.detail
                ? checkCounts(canonicalOnly, detailTemplate)
                : result.formatIssues;
            // Links the parent's earlier research had and the rewrite dropped are kept (no AI call; part of the saved detail).
            // "Only the new content" does not read the old Detail, so nothing is carried there.
            const carried =
              mode === "fresh"
                ? canonicalOnly
                : carryForwardSources(
                    canonicalOnly,
                    [latest.summary, latest.detail, latest.newFindings, latest.visualReferences],
                    [summary, canonicalOnly, references],
                    outputLanguage,
                    detailTemplate
                  );
            const composed = await this.composeWrite({
              mode,
              path,
              oldDetail: latest.detail,
              aiDetail: carried,
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
          await repo.updateNote(
            path,
            {
              summary,
              detail: written,
              visualReferences: references,
              // The findings are cleared only when the model saw them (the rewrite folds them in); unsent ones stay.
              ...(options.findingsSent() ? { newFindings: "" } : {}),
              status: "completed",
              ...formatIssuesPatch(issues, language)
            },
            { detailTemplate }
          );
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
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          fail(t("ui.research_stopped_existing_content_was_preserved"));
        } else {
          console.error("VAM synthesis write", error);
          fail(this.ports.recordFailure(t("log.child_integration_failed"), error));
        }
      }
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        await repo.updateNote(path, { status: note.status });
        fail(t("ui.research_stopped_existing_content_was_preserved"));
      } else {
        console.error("Visual Agent Map child integration", error);
        await repo.updateNote(path, { status: "error", lastError: failureReason(error) });
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
            if (JSON.stringify(latest.documents) !== options.recordedSources()) throw changed();
            // Stop pressed while the sources were re-read still wins: nothing is written.
            if (options.signal.aborted) throw aborted();
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
      if (JSON.stringify(latest.documents) !== options.recordedSources()) throw changed();
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
  }): Promise<{ ok: true; detail: string; record: WritebackRecord } | { ok: false; message: string }> {
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
    const runStyle =
      givenStyle ??
      (options.resolveStyle
        ? await options.resolveStyle(outputLanguage)
        : this.ports.runStyle({ note, outputLanguage }));
    const detailTemplate = runStyle.template;
    const context: TaskContext = withThinkingOrigin(
      {
        title: note.title,
        summary: summaryForPrompt(note.summary, outputLanguage),
        rules: "",
        detail: note.detail,
        task: note.prompt,
        ancestors: (await options.ancestors?.(outputLanguage)) ?? "",
        userTexts: options.userTexts?.() ?? "",
        workingFindings: note.newFindings,
        sourceContext: "",
        mode: "task",
        researchMode: note.researchMode,
        researchDepth: "normal",
        visualMode: note.visualMode,
        ...(runStyle.toneText ? { toneText: runStyle.toneText } : {}),
        ...overrides,
        detailTemplate,
        ...runStyle.contextFields,
        updateMode: runStyle.updateMode,
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
    const language = settings().language;
    this.pendingSuggestions.delete(path);
    // A diagram job still running for the previous result of this note must not land on the new run.
    this.abortCharts(path);
    const activeTasks = this.ports.activeTasks();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides.signal?.aborted) controller.abort();
    else overrides.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    activeTasks.set(path, controller);
    // Stage, seconds and the unsaved preview of this run; an attempt id from the service replaces the placeholder.
    // A plugin double without a progress store runs without progress lines.
    const progress = this.ports.progress() as RunProgress | undefined;
    let progressAttempt = "starting";
    progress?.begin(path, progressAttempt, Date.now(), used.model, styleLabel);
    const observer: ResearchObserver = {
      onAttempt: id => {
        progressAttempt = id;
        progress?.newAttempt(path, id, Date.now());
      },
      onStage: (id, stage, query) => progress?.stage(path, id, stage, Date.now(), query),
      onPreview: (id, fields) => progress?.preview(path, id, fields ?? {}),
      onSlow: (id, slow, resend) => progress?.markSlow(path, id, slow, resend)
    };
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
      progress?.end(path, progressAttempt);
      releaseRun();
    };
    let startupStatusAttempted = false;
    let raw: RawSnapshot | null = null;
    try {
      startupStatusAttempted = true;
      const original = await this.readOriginal(context.updateMode ?? "merge", path, options);
      await repo.updateNote(path, { status: "running" });
      await options.onStarted?.();
      raw = await this.snapshotRaw(original, path, options);
      if (controller.signal.aborted) {
        try {
          await repo.updateNote(path, { status: note.status });
        } finally {
          releaseStartup();
        }
        return null;
      }
    } catch (error) {
      try {
        if (startupStatusAttempted) await repo.updateNote(path, { status: note.status });
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
        observer
      )
      .then(result =>
        this.ports.mutate()(async () => {
          // The answer is final (or about to be dropped): the unsaved preview goes away before anything is written.
          progress?.end(path, progressAttempt);
          const latest = await repo.readNote(path, options.map);
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
            await repo.updateNote(path, { status: note.status });
            if (exchangeId)
              exchanges()?.failed(
                exchangeId,
                t(stale ? "log.stale_result_not_written" : "log.stopped_result_not_written")
              );
            if (stale) fail(t("ui.the_topic_changed_so_the_outdated_ai_result_was_not_saved"));
            return;
          }
          // Write-back comes after the stale fence: the old Detail is `latest.detail`, which equals the one the run started with.
          const mode: WritebackMode = context.updateMode ?? "merge";
          const writeLanguage = noteLanguageOf(context.outputLanguage ?? settings().language);
          const composed = await this.composeWrite({
            mode,
            path,
            oldDetail: latest.detail,
            // top gets the raw reply (new findings only); merge and fresh get the canonical Detail.
            aiDetail:
              mode === "top" ? result.detail : canonicalDetail(result.detail, writeLanguage, context.detailTemplate),
            summary: result.summary,
            template: context.detailTemplate ?? standardTemplate(writeLanguage),
            language: writeLanguage,
            signal: controller.signal,
            hooks: options,
            raw
          });
          if (!composed.ok) {
            await repo.updateNote(path, { status: note.status });
            if (exchangeId) exchanges()?.failed(exchangeId, composed.message);
            fail(composed.message);
            return;
          }
          await repo.updateNote(
            path,
            {
              summary: result.summary,
              detail: composed.detail,
              visualReferences: visualReferencesMarkdown(result.visualReferences, noteLanguageOf(language)),
              newFindings: "",
              status: "completed",
              // The topic remembers the mode of its latest research (Quick is stored as local).
              ...(context.researchMode ? { researchMode: context.researchMode } : {}),
              ...(mode === "top" ? { detailFormatIssues: [] } : formatIssuesPatch(result.formatIssues, language))
            },
            { detailTemplate: context.detailTemplate }
          );
          const saved = await repo.readNote(path, options.map);
          options.onWritten?.({ before: { ...latest, status: note.status }, after: saved });
          if (exchangeId) exchanges()?.completed(exchangeId);
          this.ports.clearOtherHistory(options.origin);
          options.queueCharts?.({
            path,
            saved,
            context,
            detail: saved.detail,
            formatIssues: mode === "top" ? [] : result.formatIssues,
            model: used.model,
            language: context.outputLanguage ?? settings().language,
            template: context.detailTemplate,
            ...(mode === "top" ? this.chartGuard(mode, composed.record) : {})
          });
          if (result.suggestions.length) {
            this.pendingSuggestions.set(
              path,
              result.suggestions
                .slice(0, 7)
                .map(item => ({ ...item, thinkingOriginBaseline: originBaseline(note.thinkingOrigin) }))
            );
            try {
              await (this.pendingSuggestions as { flush?: () => Promise<void> }).flush?.();
            } catch (error) {
              options.notify?.(this.ports.recordFailure(t("log.expansion_suggestions_save_failed"), error));
            }
          }
          options.done?.(result);
        })
      )
      .catch(error =>
        this.ports.mutate()(async () => {
          progress?.end(path, progressAttempt);
          if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
            await repo.updateNote(path, { status: note.status });
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
          await repo.updateNote(path, { status: "error", lastError: failureReason(error) });
          fail(this.ports.recordFailure(t("log.ai_task_failed"), error));
        })
      )
      .finally(() => {
        progress?.end(path, progressAttempt);
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

  /** Registers the stop handle of a run the view owns (selection synthesis, until ticket 05). */
  registerTask(path: string, controller: AbortController): void {
    this.ports.activeTasks().set(path, controller);
  }

  /** Releases the stop handle, only when it is still the one registered. */
  releaseTask(path: string, controller: AbortController): void {
    const tasks = this.ports.activeTasks();
    if (tasks.get(path) === controller) tasks.delete(path);
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
        if (this.charts.get(job.path) === controller) this.charts.delete(job.path);
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
