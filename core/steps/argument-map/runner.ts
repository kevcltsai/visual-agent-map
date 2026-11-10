import type { AiCalls } from "../../ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "../../provider-step-runner";
import { prepareStep, type StepDefinition } from "../../step-runner";
import { conclusionStep } from "./conclusion";
import { situationGateStep } from "./gate";
import { hypothesesStep } from "./hypotheses";
import { needsStep } from "./needs";
import { planSituationStep } from "./plan";
import { ArgumentStepError, type ArgumentStepBase } from "./shared";
import { verdictStep } from "./verdict";
import { assessmentStep } from "./v2-assessment";
import { framingStep } from "./v2-framing";
import { hypothesesV2Step } from "./v2-hypotheses";
import { needsV2Step } from "./v2-needs";
import { premiseVerdictStep } from "./v2-premise";

export * from "./conclusion";
export * from "./gate";
export * from "./hypotheses";
export * from "./needs";
export * from "./plan";
export { ArgumentStepError, type ArgumentStepBase } from "./shared";
export * from "./verdict";
export * from "./v2-assessment";
export * from "./v2-framing";
export * from "./v2-hypotheses";
export * from "./v2-needs";
export * from "./v2-premise";

/**
 * The six steps and the machine actions they serve. `revise` runs `needsStep` again for the same hypothesis; `research_situation` and
 * `research_need` are the browsing research path, not steps here.
 */
export const ARGUMENT_STEPS = {
  plan_situation: planSituationStep,
  judge_gate: situationGateStep,
  propose_hypotheses: hypothesesStep,
  add_needs: needsStep,
  revise: needsStep,
  verdict: verdictStep,
  conclude: conclusionStep
} as const;

/**
 * The methodology-6 steps that never browse, by the machine-v2 action they serve (`frame` runs before a map exists). `assess_premise` and
 * `assess_evidence` are one step over two input builders; `propose_alternatives` is `hypothesesV2Step` in mode alternatives and `next_round`
 * is `needsV2Step` in mode round. Verdict, comparison, conclusion and inference check come with V4b.
 */
export const ARGUMENT_STEPS_V2 = {
  frame: framingStep,
  assess_premise: assessmentStep,
  judge_premise: premiseVerdictStep,
  propose_hypotheses: hypothesesV2Step,
  propose_alternatives: hypothesesV2Step,
  add_needs: needsV2Step,
  next_round: needsV2Step,
  assess_evidence: assessmentStep
} as const;

export type ArgumentStepRunner<Request extends ArgumentStepBase, Output> = ProviderStepRunner<Request, Output>;

/**
 * A runner for any of the six steps over `providerStepRunner`, which always sends `textOnly: true, searchBudget: 0`: Claude
 * runs with `--tools ""`, Codex with web search disabled. There is no way to switch search on through this runner.
 */
export function providerArgumentRunner<Request extends ArgumentStepBase, Output>(
  aiCalls: AiCalls,
  stopped: () => Error = () => new ArgumentStepError("Argument step stopped")
): ArgumentStepRunner<Request, Output> {
  return providerStepRunner<Request, Output>(aiCalls, {
    name: "argument-map",
    topic: () => "Argument map",
    mapPath: request => request.usageMapPath,
    stopped
  });
}

/** Prepare (render and policy), send and parse one step. The parser refuses anything outside the request; no retry here. */
export async function askArgumentStep<Request extends ArgumentStepBase, Output>(
  step: StepDefinition<Request, Output>,
  request: Request,
  runner: ArgumentStepRunner<Request, Output>,
  signal: AbortSignal
): Promise<Output> {
  const prepared = prepareStep(step, request);
  return prepared.parse(await runner(request, signal, prepared));
}
