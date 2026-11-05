import { translate, uiLocale } from "../i18n";
import type { AiCalls } from "./ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "./provider-step-runner";
import { prepareStep } from "./step-runner";
import { buildStructureReviewNodes } from "./steps/structure-review/step";
import {
  GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS,
  GOAL_TOPIC_SUGGEST_SCHEMA,
  GOAL_TOPIC_SUGGEST_TOKEN_BUDGET,
  GoalTopicSuggestError,
  goalTopicSuggestStep,
  goalTopicTitleKey,
  parseGoalTopicSuggest,
  type GoalTopicDrop,
  type GoalTopicSuggestion,
  type GoalTopicSuggestRequest,
  type GoalTopicSuggestResult
} from "./steps/goal-topic-suggest/step";

export {
  buildStructureReviewNodes,
  GOAL_TOPIC_SUGGEST_MAX_SUGGESTIONS,
  GOAL_TOPIC_SUGGEST_SCHEMA,
  GOAL_TOPIC_SUGGEST_TOKEN_BUDGET,
  GoalTopicSuggestError,
  goalTopicTitleKey,
  parseGoalTopicSuggest
};
export type { GoalTopicDrop, GoalTopicSuggestion, GoalTopicSuggestRequest, GoalTopicSuggestResult };
export type GoalTopicSuggestRunner = ProviderStepRunner<GoalTopicSuggestRequest, GoalTopicSuggestResult>;

export function buildGoalTopicSuggestPrompt(request: GoalTopicSuggestRequest): string {
  return goalTopicSuggestStep.render(request);
}
export function providerGoalTopicSuggestRunner(aiCalls: AiCalls): GoalTopicSuggestRunner {
  return providerStepRunner<GoalTopicSuggestRequest, GoalTopicSuggestResult>(aiCalls, {
    name: "goal-topic-suggest",
    topic: request => `Goal topic suggestions · ${request.goal.trim().slice(0, 80)}`,
    stopped: () => new GoalTopicSuggestError("stopped", "Goal topic suggestions stopped")
  });
}
export class GoalTopicSuggestService {
  constructor(private readonly run: GoalTopicSuggestRunner) {}
  /**
   * Ask for topics missing for the goal. Throws {@link GoalTopicSuggestError} (localized message, `code` for the reason)
   * for an empty or over-budget request (before the provider is called), a stop, or a malformed reply. Suggestions come
   * back with REAL parent ids; unusable ones are counted in `dropped`.
   */
  async suggest(request: GoalTopicSuggestRequest, signal: AbortSignal): Promise<GoalTopicSuggestResult> {
    const stopped = (): GoalTopicSuggestError =>
      new GoalTopicSuggestError("stopped", translate(uiLocale(request.language), "error.goal_topic_suggest_stopped"));
    if (signal.aborted) throw stopped();
    const prepared = prepareStep(goalTopicSuggestStep, request);
    let raw: string;
    try {
      raw = await this.run(request, signal, prepared);
    } catch (error) {
      if (signal.aborted && !(error instanceof GoalTopicSuggestError)) throw stopped();
      if (error instanceof GoalTopicSuggestError && error.code === "stopped") throw stopped();
      throw error;
    }
    if (signal.aborted) throw stopped();
    return prepared.parse(raw);
  }
}
