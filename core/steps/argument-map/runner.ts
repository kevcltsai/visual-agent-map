import type { AiCalls } from "../../ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "../../provider-step-runner";
import { prepareStep, type StepDefinition } from "../../step-runner";
import { conclusionStep } from "./conclusion";
import { facetPlanStep } from "./facet-plan";
import { situationGateStep } from "./gate";
import { hypothesesStep } from "./hypotheses";
import { needsStep } from "./needs";
import { planSituationStep } from "./plan";
import { ArgumentStepError, type ArgumentStepBase } from "./shared";
import { verdictStep } from "./verdict";

export * from "./conclusion";
export * from "./facet-plan";
export * from "./gate";
export * from "./hypotheses";
export * from "./needs";
export * from "./plan";
export { ArgumentStepError, type ArgumentStepBase } from "./shared";
export * from "./verdict";

/**
 * The steps and the machine actions they serve (`plan_facets` is the facet-judged map's counterpart of `plan_situation`). `revise` runs `needsStep` again for the same hypothesis; `research_situation` and
 * `research_need` are the browsing research path, not steps here.
 */
export const ARGUMENT_STEPS = {
  plan_situation: planSituationStep,
  plan_facets: facetPlanStep,
  judge_gate: situationGateStep,
  propose_hypotheses: hypothesesStep,
  add_needs: needsStep,
  revise: needsStep,
  verdict: verdictStep,
  conclude: conclusionStep
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
