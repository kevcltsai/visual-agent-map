import { aimPhase } from "../../../ai/aim-prompt";
import type { AimContract } from "../../../ai/aim-contracts";
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
  strictGapAudit: boolean;
  webResearch: boolean;
  contract?: AimContract;
  /** Selects provider-specific output instructions; Codex prompts stay as they were. Absent: Codex. */
  provider?: AiProviderId;
}

/**
 * The step id of a task request. AIM requests are `aim.<phase>` (the phase marker in the task text); the two
 * reference rounds are their own steps; everything else is `task.run`.
 */
export type TaskStepRole = "reference-extract" | "reference-reduce";
export function taskStepId(context: TaskContext, role?: TaskStepRole): string {
  if (role) return `task.${role}`;
  return context.promptProfile === "aim" ? `aim.${aimPhase(context.task) ?? "unspecified"}` : "task.run";
}

/**
 * One model task over a TaskContext. `render` is the regular task prompt, or `buildAimPrompt` for AIM requests, so no
 * AIM template moved. The schema depends on the context (AIM contract, gap audit, delivery acceptance, web research),
 * so the caller chooses it with `taskResponseShape` and builds the step for that request.
 */
export function createTaskStep(id: string, schema: unknown): StepDefinition<TaskStepInput, AiResult> {
  return {
    id,
    version: 1,
    schema,
    render: ({ context, language, provider }) => taskPrompt(context, language, provider),
    parse: (raw, input) =>
      parseAiResult(raw, input.providerLabel, input.language, input.strictGapAudit, input.webResearch, input.contract)
  };
}
