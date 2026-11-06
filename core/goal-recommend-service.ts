import { translate, uiLocale } from "../i18n";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep } from "./step-runner";
import {
  GOAL_RECOMMEND_MAX_SUGGESTIONS,
  GOAL_RECOMMEND_SCHEMA,
  GOAL_RECOMMEND_TOKEN_BUDGET,
  GoalRecommendError,
  goalRecommendRequired,
  goalRecommendStep,
  goalRecommendTitleKey,
  parseGoalRecommend,
  type GoalRecommendDrop,
  type GoalRecommendItem,
  type GoalRecommendRequest,
  type GoalRecommendResult,
  type GoalRecommendScope,
  type GoalRecommendSuggestion
} from "./steps/goal-recommend/step";

export {
  GOAL_RECOMMEND_MAX_SUGGESTIONS,
  GOAL_RECOMMEND_SCHEMA,
  GOAL_RECOMMEND_TOKEN_BUDGET,
  GoalRecommendError,
  goalRecommendStep,
  goalRecommendTitleKey,
  parseGoalRecommend
};
export type {
  GoalRecommendDrop,
  GoalRecommendItem,
  GoalRecommendRequest,
  GoalRecommendResult,
  GoalRecommendScope,
  GoalRecommendSuggestion
};
export type GoalRecommendRunner = ProviderStepRunner<GoalRecommendRequest, GoalRecommendResult>;

/** How far the model's reply has come: tiers received so far, and (scope `all`) how many cards it must cover. */
export interface GoalRecommendReceived {
  received: number;
  total?: number;
}
/** Counts only `"tier"` (an item); a suggestion's `"suggestedTier"` has another key and is never counted. */
const TIER_FIELD = /"tier"\s*:\s*"(?:core|support|side)"/g;
const PROGRESS_INTERVAL_MS = 200;

export interface GoalRecommendHooks {
  /** Claude only (the reply streams): tiers received so far, at most every 200 ms; `null` clears it. Never called for Codex. */
  onProgress?: (progress: GoalRecommendReceived | null) => void;
}

export function buildGoalRecommendPrompt(request: GoalRecommendRequest): string {
  return goalRecommendStep.render(request);
}
export function providerGoalRecommendRunner(aiCalls: AiCalls): GoalRecommendRunner {
  return providerStepRunner<GoalRecommendRequest, GoalRecommendResult>(aiCalls, {
    name: "goal-recommend",
    topic: request => `Goal recommend · ${request.goal.trim().slice(0, 80)}`,
    mapPath: request => request.usageMapPath,
    stopped: () => new GoalRecommendError("stopped", "Goal recommend stopped"),
    stream: true
  });
}
export class GoalRecommendService {
  constructor(
    private readonly run: GoalRecommendRunner,
    /** The clock the progress throttle reads; tests pass their own. */
    private readonly now: () => number = Date.now
  ) {}
  /**
   * Recommend for a goal with exactly ONE provider call: no repair round, no retry. Throws {@link GoalRecommendError}
   * (localized message, `code` for the reason) for an empty or over-budget request (before the provider is called), a
   * stop, or any reply the strict parser refuses. Items and suggestions come back with REAL ids.
   */
  async recommend(
    request: GoalRecommendRequest,
    signal: AbortSignal,
    hooks: GoalRecommendHooks = {}
  ): Promise<GoalRecommendResult> {
    const stopped = (): GoalRecommendError =>
      new GoalRecommendError("stopped", translate(uiLocale(request.language), "error.relevance_grade_stopped"));
    if (signal.aborted) throw stopped();
    const prepared = prepareStep(goalRecommendStep, request);
    const total = request.scope === "all" ? goalRecommendRequired(request).length : undefined;
    let raw: string;
    try {
      raw = await this.run(request, signal, prepared, this.progressListener(hooks, total));
    } catch (error) {
      if (signal.aborted && !(error instanceof GoalRecommendError)) throw stopped();
      if (error instanceof GoalRecommendError && error.code === "stopped") throw stopped();
      throw error;
    }
    if (signal.aborted) throw stopped();
    return prepared.parse(raw);
  }
  /** Turns the stream of StructuredOutput JSON into a throttled "tiers received" count. */
  private progressListener(
    hooks: GoalRecommendHooks,
    total: number | undefined
  ): ((buffer: string | null) => void) | undefined {
    const report = hooks.onProgress;
    if (!report) return undefined;
    let last = 0;
    let shown = -1;
    const emit = (received: number): void => {
      if (received === shown) return;
      shown = received;
      last = this.now();
      try {
        report({ received, ...(total === undefined ? {} : { total }) });
      } catch {
        /* Progress is cosmetic and must not fail the run. */
      }
    };
    return buffer => {
      if (buffer === null) {
        shown = -1;
        try {
          report(null);
        } catch {
          /* see above */
        }
        return;
      }
      if (buffer === "") return emit(0);
      const now = this.now();
      if (now - last < PROGRESS_INTERVAL_MS) return;
      emit(buffer.match(TIER_FIELD)?.length ?? 0);
    };
  }
}
