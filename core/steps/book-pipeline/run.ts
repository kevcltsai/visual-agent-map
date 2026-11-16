import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, type StepDefinition } from "../../step-runner";
import { isBookStepError, type BookStepBase } from "./base";

/** What a plan step's exchange-log entry says when it fails: a fixed code, never owner text or the model's reply. */
export const planFailMessage = (error: unknown): string => (isBookStepError(error) ? "invalid_reply" : "failed");

/**
 * One text-only plan call (whole-book plan or one card's brief): no tools, no web, the budget reserved before the provider is
 * asked, and nothing of the prompt or reply in the exchange log (`noContentLog`). The caller's retry loop owns attempts.
 */
export async function runPlanStep<Request extends BookStepBase, Output>(
  aiCalls: AiCalls,
  step: StepDefinition<Request, Output>,
  request: Request,
  run: { signal: AbortSignal; admission?: AdmissionContext }
): Promise<Output> {
  const prepared = prepareStep(step, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Book pipeline plan",
      taskName: "book-pipeline-plan",
      signal: run.signal,
      localCodex: true,
      noContentLog: true,
      failMessage: planFailMessage,
      usage: { action: "other", mapPath: request.usageMapPath },
      ...(run.admission ? { admission: run.admission } : {}),
      task: { textOnly: true, searchBudget: 0 }
    },
    raw => prepared.parse(raw)
  );
}
