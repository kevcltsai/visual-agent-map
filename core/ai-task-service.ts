import { randomUUID } from "node:crypto";
import {
  packReferenceChunks,
  referenceBatches,
  referenceCatalog,
  resolveDetailReferences,
  resolveSummaryReferences
} from "../ai/reference-materials";
import { buildPreparedTaskContext, estimateTokens } from "../ai/context-builder";
import { effectiveReasoningLevel, normalizeReasoningLevel } from "../ai/task-policy";
import { canonicalDetail } from "../ai/result-utils";
import { normalizeDetailHeadings, normalizeMathDelimiters } from "../ai/markdown-blocks";
import { checkCounts, countIssueText } from "../ai/detail-templates";
import type { AiResult, ReasoningLevel, TaskContext } from "../ai/types";
import { noteLanguageOf, translate, t, type UiLanguage } from "../i18n";
import { CLAUDE_MODEL_CHOICES, providerForModel } from "../ai/providers/provider";
import type { CodexAppServerRuntime, CodexWebSearchEvent } from "../ai/runtime/codex-app-server";
import type { ClaudeCodeCliRuntime } from "../ai/runtime/claude-code-cli";
import type { AiExchangeLog, AiMilestones } from "../ai-exchange-log";
import type { ResearchObserver, ResearchStageName } from "../ai/research-observer";
import { runtimeStepProvider, type ExchangeSink, type RuntimeTaskControls } from "./runtime-step-provider";
import { prepareStep, StepRunner } from "./step-runner";
import { referenceTask } from "./steps/reference/step";
import { taskResponseShape } from "./steps/task/schemas";
import { repairCounts, sourceRegistry } from "./steps/task/fragments";
import { createTaskStep, taskStepId, type TaskStepRole } from "./steps/task/step";
import { chartStep, ChartRejected } from "./steps/chart/step";
import { applyCharts, existingDiagrams, type ChartCode } from "./steps/chart/insert";
import { readerFacingDetail } from "./steps/task/render";

export { extractJsonObject } from "./steps/task/parse";

/** How long a research request may go without any model event before the slow notice (and the re-send) is offered. */
export const FIRST_EVENT_WAIT_MS = 20_000;

/** Timer and wall clock of the first-event watchdog; tests replace it with a fake. */
export interface AttemptClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
function cancelled(): Error {
  const error = new Error(t("ui.ai_task_cancelled"));
  error.name = "AbortError";
  return error;
}
const realClock: AttemptClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  clearTimeout: handle => window.clearTimeout(handle as number)
};

/** What one attempt of the observed main call needs on top of the shared controls. */
interface AttemptSetup {
  signal: AbortSignal;
  /** The exchange id the previous attempt promised when it was replaced. */
  exchangeId?: string;
  extraMilestones: () => AiMilestones;
  hooks: Pick<
    RuntimeTaskControls,
    "onAccepted" | "stream" | "onStreamMode" | "onFirstEvent" | "onStage" | "onStructuredDelta" | "onActivity"
  >;
  onExchange: (id: string) => void;
  /** Runs when the reply arrives; throws for a superseded attempt so its entry is not flipped from failed back to received. */
  afterReply: () => void;
}

export interface AiTaskServiceOptions {
  /** Clock of the first-event watchdog. Absent: the real one. */
  clock?: AttemptClock;
  pluginDirectory: () => string;
  language: () => UiLanguage;
  defaultReasoning: () => ReasoningLevel;
  exchangeLoggingEnabled: () => boolean;
  exchanges: () => AiExchangeLog | null;
  codexRuntime: (directory: string, local: boolean) => CodexAppServerRuntime;
  claudeRuntime: (directory: string) => ClaudeCodeCliRuntime;
  /** True when Obsidian's mermaid parses the diagram. Absent: the chart step skips the parse check. */
  mermaidParses?: (code: string) => Promise<boolean>;
  /** The "Add diagrams after research" setting. Absent: diagrams are on. */
  diagramsEnabled?: () => boolean;
}

export class AiTaskService {
  constructor(private readonly options: AiTaskServiceOptions) {}

  async askModel(
    input: TaskContext,
    model: string,
    reasoning?: unknown,
    signal?: AbortSignal,
    onExchange?: (id: string) => void,
    onRequestAccepted?: () => void,
    /** Receives provider web activity in the Codex webSearch event shape; results may contain snippets only, not page bodies. */
    onWebSearchEvent?: (event: CodexWebSearchEvent) => void,
    /** Progress of a research request: stages, the answer being written (never saved) and the slow notice with its re-send. */
    observer?: ResearchObserver
  ): Promise<AiResult> {
    return this.execute(input, model, reasoning, signal, onExchange, onRequestAccepted, onWebSearchEvent, observer);
  }

  /** `role` names the two reference rounds so they are logged as their own steps; every other request is a task or AIM step. */
  private async execute(
    input: TaskContext,
    model: string,
    reasoning: unknown,
    signal: AbortSignal | undefined,
    onExchange: ((id: string) => void) | undefined,
    onRequestAccepted: (() => void) | undefined,
    onWebSearchEvent: ((event: CodexWebSearchEvent) => void) | undefined,
    observer: ResearchObserver | undefined,
    role?: TaskStepRole
  ): Promise<AiResult> {
    if (
      input.timeoutMs !== undefined &&
      (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 180_000 || input.timeoutMs > 600_000)
    )
      throw new Error("Invalid AI task timeout.");
    const provider = providerForModel(model);
    if (provider === "claude" && !CLAUDE_MODEL_CHOICES.some(choice => choice.id === model)) {
      throw new Error(t("ui.claude_model_is_not_supported_0", model));
    }

    if (estimateTokens(input.sourceContext) > 32_000) throw new Error(t("ui.source_context_exceeds_budget"));
    let context = input;
    let accepted = onRequestAccepted;
    const referenceGroups = context.referenceGroups ?? [];
    if (referenceGroups.some(group => group.documents.length)) {
      // Reference extraction sends model requests before the main one. The first accepted request
      // counts as the task starting, so callers can move it to the background without waiting.
      let acceptedOnce = false;
      accepted = onRequestAccepted
        ? (): void => {
            if (acceptedOnce) return;
            acceptedOnce = true;
            onRequestAccepted();
          }
        : undefined;
      // A merge or synthesis that fits one batch sends the documents as they are: an extraction pass would paraphrase (and
      // may drop) the very text being combined, and costs a second request. Over-budget sources still go through extraction.
      const direct = context.referenceDelivery === "direct" ? referenceBatches(referenceGroups) : [];
      const findings =
        direct.length === 1
          ? direct[0]
          : await this.extractReferenceFindings(context, model, reasoning, signal, accepted);
      context = {
        ...context,
        sourceContext: [context.sourceContext, findings, sourceRegistry(referenceCatalog(referenceGroups))]
          .filter(Boolean)
          .join("\n\n"),
        referenceGroups: undefined
      };
    }

    const totalStarted = Date.now();
    const prepared = buildPreparedTaskContext(context, model, 32_000, provider);
    if (prepared.context.sourceContext !== context.sourceContext) {
      throw new Error(t("ui.source_context_exceeds_budget"));
    }
    context = prepared.context;
    if (!input.countRepair) input.onWorkingFindingsSent?.(context.workingFindings ?? "");
    const pluginDirectory = this.options.pluginDirectory();
    const outputLanguage = context.outputLanguage ?? this.options.language();
    const shape = taskResponseShape(context);
    const step = prepareStep(createTaskStep(taskStepId(context, role), shape.schema), {
      context,
      language: outputLanguage,
      provider,
      providerLabel: provider === "claude" ? "Claude Code" : "Codex App Server",
      strictGapAudit: shape.isAimGapAudit,
      webResearch: shape.isIsolatedWebResearch,
      contract: shape.contract
    });

    console.debug("Visual Agent Map AI metrics", prepared.metrics);
    const providerStarted = Date.now();
    const effort = effectiveReasoningLevel(
      context,
      normalizeReasoningLevel(reasoning ?? this.options.defaultReasoning())
    );
    const exchanges = this.options.exchangeLoggingEnabled() ? this.options.exchanges() : null;
    let exchangeId = "";
    // Turning exchange logging off while a task runs stops recording from then on, so every write re-checks the setting.
    const sink = this.exchangeSink();

    // Set once the first request's entry is closed because the repair request replaced it; the catch must not reopen it.
    let supersededClosed = false;
    let stage = t("log.stage_starting_ai");
    try {
      const controls = {
        signal,
        ...(input.timeoutMs !== undefined
          ? {
              timeoutMs: Math.min(600_000, Math.max(180_000, input.timeoutMs)),
              // The timeout is an interface message: it follows the interface language, not the content language.
              timeoutMessage: translate(
                this.options.language(),
                "ui.aim_task_timeout",
                Math.ceil(Math.min(600_000, Math.max(180_000, input.timeoutMs)) / 60_000)
              )
            }
          : {}),
        ...(context.aimIsolatedResearch
          ? { webSearchOnly: context.researchMode !== "local", textOnly: context.researchMode === "local" }
          : {}),
        onAccepted: accepted,
        // Search depth guides investigation; it does not impose a per-task query cap.
        // Codex uses 0 as no steering budget; Claude receives webSearch separately.
        searchBudget: 0,
        webSearch: context.researchMode !== "local",
        onRequest: (): void => {
          stage = t("log.stage_waiting_reply");
        }
      };
      // The provider logs begin, sent and received; this method ends the entry with parsed or its own failed message.
      const runner = new StepRunner(
        runtimeStepProvider({
          claude: () => this.options.claudeRuntime(pluginDirectory),
          codex: local => this.options.codexRuntime(pluginDirectory, local),
          exchanges: () => sink,
          localCodex: context.researchMode === "local"
        })
      );
      const sendOnce = (setup?: AttemptSetup) =>
        runner.send(step, {
          model,
          effort,
          topic: context.title,
          mode: context.mode ?? "task",
          task: { ...controls, onWebSearchEvent, ...(setup ? { ...setup.hooks, signal: setup.signal } : {}) },
          finish: "caller",
          requestLog: "request",
          ...(setup
            ? { exchangeId: setup.exchangeId, extraMilestones: setup.extraMilestones, afterReply: setup.afterReply }
            : {}),
          onExchange: id => {
            exchangeId = id;
            setup?.onExchange(id);
            onExchange?.(id);
          }
        });
      // Only the main call of a research request is observed (not reference extraction, a count repair or the chart step).
      const { raw } =
        observer && role === undefined && !input.countRepair
          ? await this.sendObserved(observer, signal, accepted, sendOnce)
          : await sendOnce();
      stage = t("log.stage_parsing_reply");
      let result = step.parse(raw);
      if (readerFacingDetail(input)) {
        result.detail = normalizeMathDelimiters(normalizeDetailHeadings(result.detail));
        result.summary = normalizeMathDelimiters(result.summary);
      }
      if (referenceGroups.length) result.summary = resolveSummaryReferences(result.summary, referenceGroups);
      // Runs without sources too, so a source footnote kept from the previous detail keeps its definition.
      if (referenceGroups.length || /\[\^/.test(result.detail))
        result.detail = resolveDetailReferences(result.detail, referenceGroups, input.detail, input.detailTemplate);
      if (this.options.exchangeLoggingEnabled()) exchanges?.parsed(exchangeId);
      const template = input.detailTemplate;
      if (
        template &&
        template.sections.some(section => section.count) &&
        input.mode !== "decompose" &&
        input.detailFormat !== "adaptive"
      ) {
        let issues = checkCounts(canonicalDetail(result.detail, noteLanguageOf(outputLanguage), template), template);
        if (issues.length && !input.countRepair) {
          const firstExchangeId = exchangeId;
          try {
            const repaired = await this.execute(
              {
                ...input,
                detail: result.detail,
                summary: result.summary,
                task: repairCounts(
                  outputLanguage,
                  issues.map(issue => `- ### ${issue.section}: ${countIssueText(issue, outputLanguage)}`).join("\n")
                ),
                workingFindings: "",
                sourceContext: "",
                referenceGroups: [],
                researchMode: "local",
                countRepair: true
              },
              model,
              reasoning,
              signal,
              onExchange,
              undefined,
              undefined,
              undefined,
              role
            );
            // Only the detail comes from the repair; it runs local, so its summary, suggestions and visual
            // references would replace the first reply's with less.
            result = { ...result, detail: repaired.detail };
            issues = checkCounts(canonicalDetail(result.detail, noteLanguageOf(outputLanguage), template), template);
          } catch (error) {
            if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
          } finally {
            // The repair has its own entry, which the caller finishes; close the first one that it supersedes.
            if (this.options.exchangeLoggingEnabled()) exchanges?.completed(firstExchangeId);
            supersededClosed = true;
          }
        }
        result.formatIssues = issues;
      }
      console.debug("Visual Agent Map AI metrics", {
        ...prepared.metrics,
        providerMs: Date.now() - providerStarted,
        totalMs: Date.now() - totalStarted
      });
      return result;
    } catch (error) {
      if (this.options.exchangeLoggingEnabled() && !supersededClosed)
        exchanges?.failed(
          exchangeId,
          t("log.stage_failure_0_1", stage, error instanceof Error ? error.message : String(error))
        );
      throw error;
    }
  }

  /**
   * The observed main call (S3, D-2026-10-25): each attempt runs one model request. Without a model event for
   * {@link FIRST_EVENT_WAIT_MS} after the prompt is written the observer is told (`onSlow`), with a handle that replaces
   * the attempt: it stops the old request, marks its exchange failed and sends the same prompt again inside this same
   * call, so the caller's stale check and running flag stay as they are and nothing from the old attempt can be written.
   * Never automatic. The task's own signal wins over a re-send.
   */
  private async sendObserved<Sent>(
    observer: ResearchObserver,
    taskSignal: AbortSignal | undefined,
    accepted: (() => void) | undefined,
    send: (setup: AttemptSetup) => Promise<Sent>
  ): Promise<Sent> {
    const clock = this.options.clock ?? realClock;
    const iso = (): string => new Date(clock.now()).toISOString();
    const safe = (callback: () => void): void => {
      try {
        callback();
      } catch {
        /* An observer must not be able to fail the request. */
      }
    };
    let attemptNumber = 0;
    let promisedId: string | undefined;
    let previousExchange = "";
    for (;;) {
      if (taskSignal?.aborted) throw cancelled();
      attemptNumber++;
      const attemptId = randomUUID();
      const controller = new AbortController();
      const onTaskAbort = (): void => controller.abort();
      taskSignal?.addEventListener("abort", onTaskAbort, { once: true });
      const exchangeIdForAttempt = promisedId;
      promisedId = undefined;
      const extra: AiMilestones = previousExchange ? { resendOf: previousExchange } : {};
      let exchangeId = "";
      let resendRequested = false,
        firstEvent = false,
        watching = true,
        timer: unknown;
      // After a re-send or a stop, whatever the old attempt still reports is dropped.
      const live = (): boolean => !controller.signal.aborted && !resendRequested;
      const disarm = (): void => {
        if (timer === undefined) return;
        clock.clearTimeout(timer);
        timer = undefined;
      };
      const resend = (): void => {
        if (taskSignal?.aborted || !live() || firstEvent) return;
        resendRequested = true;
        disarm();
        promisedId = randomUUID();
        extra.resentAs = promisedId;
        controller.abort();
      };
      const arm = (): void => {
        disarm();
        if (!watching || firstEvent || !live()) return;
        timer = clock.setTimeout(() => {
          timer = undefined;
          if (firstEvent || !live()) return;
          extra.slowShownAt = iso();
          safe(() => observer.onSlow?.(attemptId, true, resend));
        }, FIRST_EVENT_WAIT_MS);
      };
      const seen = (): boolean => {
        if (!live()) return false;
        if (!firstEvent) {
          firstEvent = true;
          disarm();
          extra.firstEventAt ??= iso();
          if (extra.slowShownAt) safe(() => observer.onSlow?.(attemptId, false));
        }
        return true;
      };
      const stage = (name: ResearchStageName, query?: string): void => {
        const stages = (extra.stages ??= []);
        if (stages.length < 20 && stages.at(-1)?.stage !== name) stages.push({ stage: name, at: iso() });
        safe(() => observer.onStage?.(attemptId, name, query));
      };
      safe(() => observer.onAttempt?.(attemptId, attemptNumber));
      const setup: AttemptSetup = {
        signal: controller.signal,
        exchangeId: exchangeIdForAttempt,
        extraMilestones: () => ({ ...extra }),
        hooks: {
          stream: true,
          onAccepted: (): void => {
            accepted?.();
            if (!live()) return;
            if (!extra.acceptedAt) {
              extra.acceptedAt = iso();
              // The card shows "waiting for the model" from acceptance, so the stage list starts there (KPI T1).
              (extra.stages ??= []).push({ stage: "waiting", at: extra.acceptedAt });
            }
            arm();
          },
          // Without stream events (json mode) the first model event cannot be seen, so the notice would be a false alarm.
          onStreamMode: mode => {
            if (mode !== "stream-json") {
              watching = false;
              disarm();
            }
          },
          onFirstEvent: () => {
            seen();
          },
          onStage: (name, query) => {
            if (seen()) safe(() => observer.onStage?.(attemptId, name, query));
          },
          onStructuredDelta: fields => {
            if (!seen()) return;
            const preview = fields ? { summary: fields.summary, detail: fields.detail } : null;
            safe(() => observer.onPreview?.(attemptId, preview));
          },
          onActivity: activity => {
            if (!seen() || activity === "started") return;
            stage(activity);
          }
        },
        onExchange: id => {
          exchangeId = id;
        },
        afterReply: () => {
          if (!live()) throw cancelled();
        }
      };
      // The race makes the loop independent of a runtime that is slow to honour the abort.
      const replaced = new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener("abort", () => reject(cancelled()), {
          once: true
        })
      );
      replaced.catch(() => undefined);
      try {
        const attempt = send(setup);
        attempt.catch(() => undefined);
        const sent = await Promise.race([attempt, replaced]);
        // A reply that arrives after the user replaced this attempt is discarded.
        if (!(resendRequested && !taskSignal?.aborted)) return sent;
      } catch (error) {
        if (taskSignal?.aborted || !resendRequested) throw error;
      } finally {
        disarm();
        taskSignal?.removeEventListener("abort", onTaskAbort);
      }
      this.failExchange(exchangeId, t("log.research_resent_by_user"));
      previousExchange = exchangeId;
    }
  }

  /**
   * Whether a finished note of this request gets the background chart step: the request asked for charts, the setting
   * is on, and it is a plain research task or synthesis (never a count repair, interim detail, AIM or decompose/merge).
   */
  chartEligible(input: TaskContext): boolean {
    return (
      !!input.addCharts &&
      this.diagramsOn() &&
      !input.countRepair &&
      !input.intermediateDetail &&
      input.promptProfile !== "aim" &&
      (input.mode === "task" || input.mode === "synthesize")
    );
  }

  /**
   * The chart step for a note that was already written: one local, tool-free model call, run after the write. Returns the
   * detail with the diagrams added, or unchanged when the step finds none or fails; only a stop throws. `onExchange`
   * receives the chart entry's id so the caller can mark it failed when it decides not to apply the result.
   */
  async chartDetail(request: {
    input: TaskContext;
    detail: string;
    /** The count issues of the written note (`AiResult.formatIssues`); the diagrams must not change them. */
    countIssues?: ReturnType<typeof checkCounts>;
    model: string;
    signal?: AbortSignal;
    onExchange?: (id: string) => void;
  }): Promise<string> {
    if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return this.addCharts(
      request.input,
      request.detail,
      request.countIssues,
      request.input.outputLanguage ?? this.options.language(),
      providerForModel(request.model),
      request.model,
      request.signal,
      this.exchangeSink(),
      request.onExchange
    );
  }

  /** Marks an exchange failed with the caller's reason (for example a stale chart that was not applied). */
  failExchange(id: string, reason: string): void {
    if (id && this.options.exchangeLoggingEnabled()) this.options.exchanges()?.failed(id, reason);
  }

  /** A guarded view of the exchange log: every write re-checks the logging setting. Null when logging is off. */
  private exchangeSink(): ExchangeSink | null {
    const exchanges = this.options.exchangeLoggingEnabled() ? this.options.exchanges() : null;
    const record =
      <Args extends unknown[]>(write: (...args: Args) => void) =>
      (...args: Args): void => {
        if (this.options.exchangeLoggingEnabled()) write(...args);
      };
    return (
      exchanges && {
        begin: entry => exchanges.begin(entry),
        sent: record((id: string, body: string, prompt?: string) => exchanges.sent(id, body, prompt)),
        received: record((id: string, body: string) => exchanges.received(id, body)),
        completed: record((id: string) => exchanges.completed(id)),
        failed: record((id: string, error: string) => exchanges.failed(id, error)),
        milestones: record((id: string, data: AiMilestones) => exchanges.milestones(id, data))
      }
    );
  }

  private diagramsOn(): boolean {
    return this.options.diagramsEnabled?.() !== false;
  }

  /**
   * The chart step for a finished AIM conclusion (its final detail only, never interim or gap-audit text). Returns the
   * detail unchanged when diagrams are off or the step fails; only a stop throws.
   */
  async addDiagramsToDetail(request: {
    title: string;
    detail: string;
    language: UiLanguage;
    model: string;
    signal?: AbortSignal;
    /** Called once, right before the step starts; never when diagrams are off. */
    onStart?: () => void;
  }): Promise<string> {
    if (!this.diagramsOn()) return request.detail;
    if (request.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    request.onStart?.();
    const input: TaskContext = {
      title: request.title,
      summary: "",
      rules: "",
      detail: request.detail,
      task: "",
      ancestors: "",
      mode: "task",
      detailFormat: "adaptive",
      outputLanguage: request.language
    };
    return this.addCharts(
      input,
      request.detail,
      undefined,
      request.language,
      providerForModel(request.model),
      request.model,
      request.signal,
      this.exchangeSink()
    );
  }

  /**
   * The chart step: one local, tool-free model call that proposes diagrams for the finished note. Any failure other than
   * a stop leaves the detail unchanged, so a note is never worse for having been offered diagrams.
   */
  private async addCharts(
    input: TaskContext,
    detail: string,
    countIssues: ReturnType<typeof checkCounts> | undefined,
    language: UiLanguage,
    provider: "claude" | "codex",
    model: string,
    signal: AbortSignal | undefined,
    sink: ExchangeSink | null,
    onExchange?: (id: string) => void
  ): Promise<string> {
    const existing = existingDiagrams(detail);
    const remaining = 3 - existing.count;
    if (remaining <= 0 || !detail.trim()) return detail;
    const pluginDirectory = this.options.pluginDirectory();
    const step = prepareStep(chartStep, {
      title: input.title,
      detail,
      language,
      existingCount: existing.count,
      existingTypes: existing.types,
      remaining,
      provider
    });
    let exchangeId = "";
    const runner = new StepRunner(
      runtimeStepProvider({
        claude: () => this.options.claudeRuntime(pluginDirectory),
        codex: local => this.options.codexRuntime(pluginDirectory, local),
        exchanges: () => sink,
        localCodex: true
      })
    );
    const refuse = (code: ChartCode): string => {
      console.warn("Visual Agent Map chart step", code);
      if (exchangeId && this.options.exchangeLoggingEnabled())
        this.options.exchanges()?.failed(exchangeId, translate(this.options.language(), "log.chart_not_added_0", code));
      return detail;
    };
    try {
      const { raw } = await runner.send(step, {
        model,
        effort: "low",
        topic: input.title,
        mode: input.mode ?? "task",
        task: {
          signal,
          timeoutMs: 180_000,
          timeoutMessage: translate(this.options.language(), "ui.ai_task_exceeded_0_minutes", 3),
          webSearch: false,
          textOnly: true,
          searchBudget: 0
        },
        finish: "caller",
        requestLog: "request",
        onExchange: id => {
          exchangeId = id;
          onExchange?.(id);
        }
      });
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const charts = step.parse(raw);
      const applied = await applyCharts(detail, charts, { remaining, parses: this.options.mermaidParses });
      if (!applied.ok) return refuse(applied.code);
      const template = input.detailTemplate;
      if (countIssues && template && input.detailFormat !== "adaptive") {
        const after = checkCounts(canonicalDetail(applied.detail, noteLanguageOf(language), template), template);
        if (JSON.stringify(after) !== JSON.stringify(countIssues)) return refuse("counts_changed");
      }
      if (this.options.exchangeLoggingEnabled() && exchangeId) {
        this.options.exchanges()?.parsed(exchangeId);
        this.options.exchanges()?.completed(exchangeId);
      }
      return applied.detail;
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        if (exchangeId && this.options.exchangeLoggingEnabled())
          this.options.exchanges()?.failed(exchangeId, error instanceof Error ? error.message : String(error));
        throw error;
      }
      return refuse(error instanceof ChartRejected ? error.code : "runtime_error");
    }
  }

  private async extractReferenceFindings(
    context: TaskContext,
    model: string,
    reasoning: unknown,
    signal?: AbortSignal,
    onRequestAccepted?: () => void
  ): Promise<string> {
    let working = referenceBatches(context.referenceGroups ?? []);
    let round = 0;
    while (true) {
      round++;
      const batches = round === 1 ? working : packReferenceChunks(working);
      const findings: string[] = [];
      for (let index = 0; index < batches.length; index++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        context.onProgress?.(t("ui.reference_processing_progress", index + 1, batches.length));
        const result = await this.execute(
          {
            title: context.title,
            summary: "",
            rules: "",
            detail: "",
            task: referenceTask(round === 1 ? "extract" : "reduce", this.options.language()),
            ancestors: "",
            sourceContext: batches[index],
            mode: "task",
            researchMode: "local",
            researchDepth: "fast",
            visualMode: "off",
            intermediateDetail: true
          },
          model,
          reasoning,
          signal,
          undefined,
          onRequestAccepted,
          undefined,
          undefined,
          round === 1 ? "reference-extract" : "reference-reduce"
        );
        if (!result.detail.trim()) throw new Error(t("ui.reference_processing_empty_result"));
        findings.push(result.detail.trim());
      }
      const joined = findings.map(value => `Evidence:\n${value}`).join("\n\n");
      if (joined.length <= 18_000) {
        context.onProgress?.("");
        return joined;
      }
      if (joined.length >= working.reduce((sum, value) => sum + value.length, 0)) {
        throw new Error(t("ui.reference_processing_could_not_reduce"));
      }
      working = findings;
    }
  }
}
