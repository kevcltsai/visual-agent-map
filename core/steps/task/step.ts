import type { AiResult, TaskContext } from "../../../ai/types";
import type { ContentLanguage } from "../../../i18n";
import type { AiProviderId } from "../../../ai/providers/provider";
import type { StepDefinition } from "../../step-runner";
import { parseAiResult } from "./parse";
import { taskPrompt } from "./render";

/** Everything the task prompt and its parser need; fixed when the step is prepared. */
export interface TaskStepInput {
  context: TaskContext;
  /** Output language of the prompt. */
  language: ContentLanguage;
  /** Provider label used in parse error messages, for example `Claude Code`. */
  providerLabel: string;
  /** Argument-evidence contract: the need ids the reply may cite. Absent for every other request. */
  argumentEvidenceNeedIds?: readonly string[];
  /** Selects provider-specific output instructions; Codex prompts stay as they were. Absent: Codex. */
  provider?: AiProviderId;
}

/**
 * The step id of a task request: the two reference rounds are their own steps; everything else is `task.run`.
 */
export type TaskStepRole = "reference-extract" | "reference-reduce";
export function taskStepId(context: TaskContext, role?: TaskStepRole): string {
  if (role) return `task.${role}`;
  return "task.run";
}

/**
 * One model task over a TaskContext. `render` is the regular task prompt. The schema depends on the context (the
 * argument-evidence contract), so the caller chooses it with `taskResponseShape` and builds the step for that request.
 */
export function createTaskStep(id: string, schema: unknown): StepDefinition<TaskStepInput, AiResult> {
  return {
    id,
    version: 1,
    schema,
    render: ({ context, language, provider }) => taskPrompt(context, language, provider),
    parse: (raw, input) => parseAiResult(raw, input.providerLabel, input.language, input.argumentEvidenceNeedIds)
  };
}
