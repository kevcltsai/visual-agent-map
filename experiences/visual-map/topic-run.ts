/**
 * The plugin-level registry of topic AI runs: which topics have a run in flight and the controller that stops each.
 * It imports neither obsidian nor the view; everything it needs from the plugin comes through lazy ports, because the
 * plugin replaces some of those objects after construction.
 */
import { noteLanguageOf, t, type ContentLanguage } from "../../i18n";
import type { AiResult, ReasoningLevel, Suggestion, TaskContext } from "../../ai/types";
import type { DetailTemplate } from "../../ai/detail-templates";
import type { ResearchObserver, ResearchPreviewFields, ResearchStageName } from "../../ai/research-observer";
import { canonicalDetail, visualReferencesMarkdown } from "../../ai/result-utils";
import { failureReason, type Note, type NotePatch } from "../../repository";
import type { RunStyle } from "../../ai/note-style-store";
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
  settings(): { language: ContentLanguage; aiExchangeLoggingEnabled?: boolean };
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
  /** The plugin's own Set and Map, read on every use: tests and onload replace them. */
  running(): Set<string>;
  pendingSuggestions(): Map<string, Suggestion[]>;
}

/** What a research run needs from the entry that starts it (the view); every function is optional where a run can go on without it. */
export interface ResearchStart {
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
  queueCharts?: (job: {
    path: string;
    saved: Note;
    context: TaskContext;
    detail: string;
    formatIssues?: AiResult["formatIssues"];
    model: string;
    language: ContentLanguage;
    template?: DetailTemplate;
  }) => void;
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
   * Registers a run for the topic. Returns null when the topic already has one or the module is disposed.
   * `replace` (the research run only, until ticket 05) takes the topic over from a run that is still registered: the
   * older run is not stopped, and its release then no longer frees the topic.
   */
  begin(path: string, kind: TopicRunKind, options: { replace?: boolean } = {}): TopicRunHandle | null {
    if (this.disposed || (!options.replace && this.controllers.has(path))) return null;
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
  async start(path: string, kind: "research", options: ResearchStart): Promise<AgentTaskHandle | null> {
    if (this.disposed) return null;
    const { runStyle: givenStyle, ...overrides } = options.request ?? {};
    const settings = (): ReturnType<TopicRunPorts["settings"]> => this.ports.settings();
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
    if (this.running.has(path)) {
      options.failed?.(t("ui.ai_running_ai"));
      return null;
    }
    const outputLanguage = overrides.outputLanguage ?? settings().language;
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
        addCharts: overrides.addCharts ?? true
      },
      note
    );
    const language = settings().language;
    this.pendingSuggestions.delete(path);
    // A diagram job still running for the previous result of this note must not land on the new run.
    this.abortCharts(path);
    const handle = this.begin(path, kind, { replace: true });
    if (!handle) return null;
    const controller = this.controllers.get(path)!;
    const activeTasks = this.ports.activeTasks();
    const abortFromTaskModal = (): void => controller.abort();
    if (overrides.signal?.aborted) controller.abort();
    else overrides.signal?.addEventListener("abort", abortFromTaskModal, { once: true });
    activeTasks.set(path, controller);
    // Stage, seconds and the unsaved preview of this run; an attempt id from the service replaces the placeholder.
    // A plugin double without a progress store runs without progress lines.
    const progress = this.ports.progress() as RunProgress | undefined;
    let progressAttempt = "starting";
    progress?.begin(path, progressAttempt, Date.now(), used.model, runStyle.label.fileName);
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
    try {
      startupStatusAttempted = true;
      await repo.updateNote(path, { status: "running" });
      await options.onStarted?.();
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
          await repo.updateNote(
            path,
            {
              summary: result.summary,
              detail: canonicalDetail(
                result.detail,
                noteLanguageOf(context.outputLanguage ?? settings().language),
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
          const saved = await repo.readNote(path, options.map);
          options.onWritten?.({ before: { ...latest, status: note.status }, after: saved });
          if (exchangeId) exchanges()?.completed(exchangeId);
          this.ports.clearOtherHistory(options.origin);
          options.queueCharts?.({
            path,
            saved,
            context,
            detail: saved.detail,
            formatIssues: result.formatIssues,
            model: used.model,
            language: context.outputLanguage ?? settings().language,
            template: context.detailTemplate
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
