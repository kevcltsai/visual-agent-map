import { translate, uiLocale } from "../i18n";
import type { AiTaskServiceOptions } from "./ai-task-service";
import { providerStepRunner, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep, type PreparedStep, type StepDefinition } from "./step-runner";
import {
  cardsToRecalibrate,
  parseRelevanceRecalibrate,
  RELEVANCE_RECALIBRATE_SCHEMA,
  relevanceRecalibrateRepairStep,
  relevanceRecalibrateStep,
  type RelevanceRecalibrateRepairRequest,
  type RelevanceRecalibrateRequest,
  type RelevanceRecalibrateResult
} from "./steps/relevance-recalibrate/step";
import {
  cardsToGrade,
  pinConflicts,
  gradableNodes,
  parseRelevanceGrade,
  RELEVANCE_GOAL_MAX_LENGTH,
  RELEVANCE_GRADE_SCHEMA,
  RELEVANCE_GRADE_TOKEN_BUDGET,
  RELEVANCE_REPAIR_MAX_ROUNDS,
  RelevanceGradeError,
  relevanceGradeMissingRepairStep,
  relevanceGradeRepairStep,
  relevanceGradeStep,
  relevanceHierarchyViolations,
  type PinConflict,
  type RelevancePin,
  type RelevanceRepairRequest,
  type RelevanceGradeItem,
  type RelevanceGradeRequest,
  type RelevanceGradeResult,
  type RelevanceHierarchyFailure
} from "./steps/relevance-grade/step";

export {
  gradableNodes,
  parseRelevanceGrade,
  RELEVANCE_GOAL_MAX_LENGTH,
  RELEVANCE_GRADE_SCHEMA,
  RELEVANCE_GRADE_TOKEN_BUDGET,
  RELEVANCE_REPAIR_MAX_ROUNDS,
  RelevanceGradeError,
  relevanceGradeRepairStep,
  relevanceGradeMissingRepairStep,
  relevanceHierarchyViolations,
  parseRelevanceRecalibrate,
  RELEVANCE_RECALIBRATE_SCHEMA,
  relevanceRecalibrateRepairStep,
  relevanceRecalibrateStep
};
export type {
  RelevanceGradeItem,
  RelevanceGradeRequest,
  RelevanceGradeResult,
  RelevanceRecalibrateRequest,
  RelevanceRecalibrateResult,
  RelevancePin,
  PinConflict
};
/** A card whose grade a run changed (or set for the first time), with the values needed to undo or redo it. */
export interface RelevanceGradeChange {
  id: string;
  path: string;
  title: string;
  before: { tier: RelevanceGradeItem["tier"] } | undefined;
  after: { tier: RelevanceGradeItem["tier"] };
  /** The pinned card this change follows from, when the AI named one. */
  anchor?: string;
}
export interface RelevanceGradeOutcome {
  /** Cards graded successfully, changed or not. */
  graded: number;
  changes: RelevanceGradeChange[];
  /** Cards left alone because they were deleted, renamed or moved while the AI worked. */
  skipped: number;
  /** Cards whose note could not be written. */
  failed: number;
  /** Hand-set (pinned) cards kept as they are: pinned cards on the map, plus any the write guard still met. */
  pinned: number;
  /** Which kind of run this was; the status text differs. */
  mode?: "full" | "recalibrate";
  /** The pinned cards the AI was given, for the summary's groups. */
  pins?: Array<{ id: string; title: string; tier: RelevanceGradeItem["tier"] }>;
  /** Pinned cards ranked above a pinned ancestor, with the titles to show. */
  conflicts?: Array<{
    ancestor: string;
    ancestorTier: RelevanceGradeItem["tier"];
    descendant: string;
    descendantTier: RelevanceGradeItem["tier"];
  }>;
  /** Replies that named something that was not a pin, or sent a pinned card; recorded, never an error. */
  pinnedIgnored?: number;
  anchorsDropped?: number;
  unchangedIgnored?: number;
}
/**
 * The one grading run a map can have at a time. It lives on the plugin, keyed by map path, so a second view of the
 * same map cannot start another; the view that started it only displays it and aborts it when it closes.
 */
export interface RelevanceGradeRun {
  token: number;
  owner: object;
  controller: AbortController;
  goal: string;
  status: "running" | "stopped" | "failed" | "declined" | "done";
  /** Localized reason shown in the status bar for stopped, failed and declined runs. */
  message?: string;
  outcome?: RelevanceGradeOutcome;
  /** True once the notes are being written; Stop no longer applies because nothing can be half-applied. */
  writing?: boolean;
  /** True while the AI usage notice is waiting for the user's answer; the map stays locked but nothing is being graded yet. */
  awaitingUsage?: boolean;
  /** True while a repair request (parent-child order, at most two rounds) is in flight. */
  repairing?: boolean;
  /** The history entry that undoes this run, so the status bar only offers Undo while it is still the latest. */
  historyEntry?: object;
}
/** Runs the grade or recalibrate step, and the repair steps (whose requests extend the grade request). */
export type RelevanceGradeRunner = ProviderStepRunner<RelevanceGradeRequest, RelevanceGradeResult>;
export interface RelevanceGradeHooks {
  /** Called just before each repair request is sent (at most {@link RELEVANCE_REPAIR_MAX_ROUNDS} times); `round` starts at 1. */
  onRepair?: (round: number, kind: "hierarchy" | "missing-bounded") => void;
}

export function buildRelevanceGradePrompt(request: RelevanceGradeRequest): string {
  return relevanceGradeStep.render(request);
}
export function providerRelevanceGradeRunner(
  options: AiTaskServiceOptions,
  activeTasks: Map<string, AbortController>
): RelevanceGradeRunner {
  return providerStepRunner<RelevanceGradeRequest, RelevanceGradeResult>(options, activeTasks, {
    name: "relevance-grade",
    topic: request =>
      `Relevance ${"previous" in request ? "recalibrate" : "grade"} · ${request.goal.trim().slice(0, 80)}`,
    stopped: () => new RelevanceGradeError("stopped", "Relevance grading stopped"),
    stream: true
  });
}
export class RelevanceGradeService {
  constructor(private readonly run: RelevanceGradeRunner) {}
  /**
   * Grade a map against a goal. Throws {@link RelevanceGradeError} (localized message, `code` for the reason) for a map
   * with nothing to grade, an over-budget map, a stop, or any reply that is not exactly one valid grade per card that is
   * not pinned. Pinned cards (`request.pins`) are never graded: the model sees them as anchors and bounds, an entry for
   * one is ignored. When every gradable card is pinned there is nothing to ask and no request is sent.
   * When a reply fails ONLY because cards rank above their parent (or outside their pins' bounds), a repair request
   * lists those pairs (with each card's ancestor chain) and asks for a complete corrected reply. Every repair goes
   * through the same strict parser; if it fails only on hierarchy again, a second and last round repairs the latest
   * reply. Any other failure, or a hierarchy failure after the last round, fails the whole grade with a plain message
   * (ids only in `detail`).
   */
  async grade(
    request: RelevanceGradeRequest,
    signal: AbortSignal,
    hooks: RelevanceGradeHooks = {}
  ): Promise<RelevanceGradeResult> {
    return this.drive(
      request,
      signal,
      hooks,
      relevanceGradeStep,
      failure => (failure.missing ? relevanceGradeMissingRepairStep : relevanceGradeRepairStep),
      (failure): RelevanceRepairRequest => ({
        ...request,
        previousReply: failure.reply,
        violations: failure.violations,
        ...(failure.missing ? { missing: failure.missing } : {})
      }),
      cardsToGrade(request).length === 0
    );
  }
  /**
   * Recalibrate an already graded map: the model answers only with the cards whose tier should move and the cards
   * that have no tier yet (`request.previous` holds the current AI tiers). Same errors, repair rounds and stop handling
   * as {@link grade}; an empty `items` is a valid answer ("nothing to adjust"). Nothing to ask (every gradable card is
   * pinned) sends no request.
   */
  async recalibrate(
    request: RelevanceRecalibrateRequest,
    signal: AbortSignal,
    hooks: RelevanceGradeHooks = {}
  ): Promise<RelevanceRecalibrateResult> {
    return this.drive(
      request,
      signal,
      hooks,
      relevanceRecalibrateStep,
      () => relevanceRecalibrateRepairStep,
      (failure): RelevanceRecalibrateRepairRequest => ({
        ...request,
        previousReply: failure.reply,
        violations: failure.violations
      }),
      cardsToRecalibrate(request).length === 0
    );
  }
  private async drive<
    Request extends RelevanceGradeRequest,
    Repair extends Request,
    Output extends RelevanceGradeResult
  >(
    request: Request,
    signal: AbortSignal,
    hooks: RelevanceGradeHooks,
    step: StepDefinition<Request, Output>,
    repairStep: (failure: RelevanceHierarchyFailure) => StepDefinition<Repair, Output>,
    repairRequest: (failure: RelevanceHierarchyFailure) => Repair,
    nothingToAsk: boolean
  ): Promise<Output> {
    const stopped = (): RelevanceGradeError =>
      new RelevanceGradeError("stopped", translate(uiLocale(request.language), "error.relevance_grade_stopped"));
    if (signal.aborted) throw stopped();
    const prepared = prepareStep(step, request);
    if (nothingToAsk) {
      const conflicts = pinConflicts(request);
      return { items: [], ...(conflicts.length ? { conflicts } : {}) } as unknown as Output;
    }
    const send = (made: PreparedStep<Request, Output> | PreparedStep<Repair, Output>): Promise<string> =>
      this.run(request, signal, made);
    let raw: string;
    try {
      raw = await send(prepared);
    } catch (error) {
      if (signal.aborted && !(error instanceof RelevanceGradeError)) throw stopped();
      if (error instanceof RelevanceGradeError && error.code === "stopped") throw stopped();
      if (error instanceof RelevanceGradeError && error.hierarchy && !signal.aborted)
        return this.repair(request, signal, hooks, error.hierarchy, stopped, repairStep, repairRequest, send);
      throw error;
    }
    if (signal.aborted) throw stopped();
    try {
      return prepared.parse(raw);
    } catch (error) {
      if (error instanceof RelevanceGradeError && error.hierarchy)
        return this.repair(request, signal, hooks, error.hierarchy, stopped, repairStep, repairRequest, send);
      throw error;
    }
  }
  private async repair<Request extends RelevanceGradeRequest, Repair extends Request, Output>(
    request: Request,
    signal: AbortSignal,
    hooks: RelevanceGradeHooks,
    first: RelevanceHierarchyFailure,
    stopped: () => RelevanceGradeError,
    repairStep: (failure: RelevanceHierarchyFailure) => StepDefinition<Repair, Output>,
    repairRequest: (failure: RelevanceHierarchyFailure) => Repair,
    send: (prepared: PreparedStep<Repair, Output>) => Promise<string>
  ): Promise<Output> {
    let failure = first;
    for (let round = 1; ; round++) {
      // Rendered and budget-checked before anything is shown or sent: an over-budget repair is refused.
      const prepared = prepareStep(repairStep(failure), repairRequest(failure));
      if (signal.aborted) throw stopped();
      hooks.onRepair?.(round, failure.missing ? "missing-bounded" : "hierarchy");
      let raw = "";
      let failed: Error | undefined;
      try {
        raw = await send(prepared);
      } catch (error) {
        if (signal.aborted) throw stopped();
        if (error instanceof RelevanceGradeError && error.code === "stopped") throw stopped();
        // The runner parses the reply too; a failure it found is judged below like one found here.
        failed = error instanceof Error ? error : new Error(String(error));
      }
      if (signal.aborted) throw stopped();
      try {
        if (failed) throw failed;
        return prepared.parse(raw);
      } catch (error) {
        if (!(error instanceof RelevanceGradeError) || !error.hierarchy) throw error;
        if (round >= RELEVANCE_REPAIR_MAX_ROUNDS)
          throw error.hierarchy.missing
            ? new RelevanceGradeError("invalid", error.message, undefined, error.detail ?? error.message)
            : new RelevanceGradeError(
                "invalid",
                translate(uiLocale(request.language), "error.relevance_grade_hierarchy"),
                undefined,
                error.message
              );
        failure = error.hierarchy;
      }
    }
  }
}
