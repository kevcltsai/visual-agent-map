/**
 * The plugin-level registry of topic AI runs: which topics have a run in flight and the controller that stops each.
 * It imports neither obsidian nor the view; everything it needs from the plugin comes through lazy ports, because the
 * plugin replaces some of those objects after construction.
 */
import { t } from "../../i18n";
import type { AiResult, Suggestion, TaskContext } from "../../ai/types";

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

export interface TopicRunPorts {
  /** Read on every use, never captured at construction. */
  aiTasks(): ChartTasks;
  mutate(): (work: () => Promise<void>) => Promise<void>;
  progress(): ChartProgress;
  repository(): { isDisposed?(): boolean } | undefined;
  isUnloaded(): boolean;
  /** The plugin's own Set and Map, read on every use: tests and onload replace them. */
  running(): Set<string>;
  pendingSuggestions(): Map<string, Suggestion[]>;
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

  /** Registers a run for the topic. Returns null when the topic already has one or the module is disposed. */
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
