import { translate, uiLocale, type ContentLanguage } from "../i18n";
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

/**
 * The words after "Recommending failed." on the status bar. Messages the step wrote for the learner pass through; anything
 * else (a provider refusal, a stack of JSON, schema text) becomes one plain sentence. The raw text still reaches the log
 * through the exchange log.
 */
export function goalRecommendFailureDetail(error: unknown, language: ContentLanguage): string {
  if (error instanceof GoalRecommendError || (error as { name?: unknown } | null)?.name === "GoalRecommendError")
    return (error as Error).message;
  const message = (error as { message?: unknown } | null)?.message;
  const text = (typeof message === "string" ? message : "").trim();
  const technical = /[{}[\]]|schema|json|required|properties|invalid_request|\$\.|\bat \S+:\d+/i.test(text);
  if (!text || technical || text.length > 140) return translate(uiLocale(language), "error.goal_recommend_unavailable");
  return text;
}

/** A card whose tier a run changed (or set for the first time), with the values needed to undo or redo it. */
export interface GoalRecommendChange {
  id: string;
  path: string;
  title: string;
  before: { tier: GoalRecommendItem["tier"] } | undefined;
  after: { tier: GoalRecommendItem["tier"] };
  /** The pinned card this change follows from, when the AI named one. */
  anchor?: string;
  /** True when the tier was raised by the program because a card below it ranks higher; the AI did not say it. */
  raised?: boolean;
}
export interface GoalRecommendOutcome {
  /** Cards rated successfully, changed or not. */
  graded: number;
  changes: GoalRecommendChange[];
  /** Cards left alone because they were deleted, renamed or moved while the AI worked. */
  skipped: number;
  /** Cards whose note could not be written. */
  failed: number;
  /** Hand-set (pinned) cards kept as they are. */
  pinned: number;
  /** Which request this was; set by the repository's `setupChanged` and the presence of AI tiers, nothing else. */
  scope?: GoalRecommendScope;
  /** Cards whose tier the program raised so no card ranks below one it holds (counted in `changes` too). */
  raised: number;
  /** New cards the AI recommended and the list can offer. */
  recommended: number;
  pins?: Array<{ id: string; title: string; tier: GoalRecommendItem["tier"] }>;
  conflicts?: Array<{
    ancestor: string;
    ancestorTier: GoalRecommendItem["tier"];
    descendant: string;
    descendantTier: GoalRecommendItem["tier"];
  }>;
  pinnedIgnored?: number;
  anchorsDropped?: number;
  unchangedIgnored?: number;
}
/**
 * The one recommend run a map can have at a time. It lives on the plugin, keyed by map path, so a second view of the same
 * map cannot start another; the view that started it only displays it and aborts it when it closes.
 */
export interface GoalRecommendRun {
  token: number;
  owner: object;
  controller: AbortController;
  goal: string;
  status: "running" | "stopped" | "failed" | "declined" | "done";
  /** Localized reason shown in the status bar for stopped, failed and declined runs. */
  message?: string;
  outcome?: GoalRecommendOutcome;
  /** True once the notes are being written; Stop no longer applies because nothing can be half-applied. */
  writing?: boolean;
  /** When the model request began (after the usage notice was answered); the status bar counts seconds from here. */
  startedAt?: number;
  /** Tiers received so far (Claude streaming only); shown in the status bar, never persisted. */
  received?: GoalRecommendReceived;
  /** True while the AI usage notice is waiting for the user's answer. */
  awaitingUsage?: boolean;
  /** The history entry that undoes this run, so the status bar only offers Undo while it is still the latest. */
  historyEntry?: object;
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
      new GoalRecommendError("stopped", translate(uiLocale(request.language), "error.goal_recommend_stopped"));
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
