import type { AiCalls } from "../../ai-calls";
import { providerStepRunner, type ProviderStepRunner } from "../../provider-step-runner";
import { prepareStep, renderTemplate, type StepDefinition } from "../../step-runner";
import { conclusionStep } from "./conclusion";
import { conclusionFactStep } from "./conclusion-fact";
import { facetHypothesesStep } from "./facet-hypotheses";
import { facetJudgeStep } from "./facet-judge";
import { facetPlanStep } from "./facet-plan";
import { situationGateStep } from "./gate";
import { hypothesesStep } from "./hypotheses";
import { needsStep } from "./needs";
import { quickCausalStep } from "./quick-causal";
import { ArgumentStepError, type ArgumentStepBase } from "./shared";
import { verdictStep } from "./verdict";
import retryReasonTemplate from "./retry-reason.md";

export * from "./conclusion";
export * from "./conclusion-fact";
export * from "./facet-hypotheses";
export * from "./facet-judge";
export * from "./facet-plan";
export * from "./gate";
export * from "./hypotheses";
export * from "./needs";
export * from "./quick-causal";
export { ArgumentStepError, type ArgumentStepBase } from "./shared";
export * from "./verdict";

/**
 * The steps and the machine actions they serve (`plan_facets` serves the machine's `plan_situation` action; the old plan step was removed). `revise` runs `needsStep` again for the same hypothesis; `research_situation` and
 * `research_need` are the browsing research path, not steps here.
 */
export const ARGUMENT_STEPS = {
  plan_facets: facetPlanStep,
  quick_causal: quickCausalStep,
  judge_gate: situationGateStep,
  judge_facets: facetJudgeStep,
  propose_hypotheses: hypothesesStep,
  propose_facet_hypotheses: facetHypothesesStep,
  add_needs: needsStep,
  revise: needsStep,
  verdict: verdictStep,
  conclude: conclusionStep,
  conclude_facts: conclusionFactStep
} as const;

/** The same step for the corrective retry: its prompt also says why the previous reply was refused (one short plain line). Only the render differs; the parser, schema and policy are the step's own. */
export function withRetryReason<Request extends ArgumentStepBase, Output>(
  step: StepDefinition<Request, Output>,
  reason: string
): StepDefinition<Request, Output> {
  const line = reason.replace(/\s+/g, " ").trim().slice(0, 200);
  return {
    ...step,
    render: request => `${step.render(request)}\n\n${renderTemplate(retryReasonTemplate.trim(), { reason: line })}`
  };
}

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
