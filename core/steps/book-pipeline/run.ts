import type { AdmissionContext } from "../../admission";
import type { AiCalls } from "../../ai-calls";
import { stepEffort } from "../../provider-step-runner";
import { prepareStep, type StepDefinition } from "../../step-runner";
import { isBadRequest, isProviderError, providerErrorText } from "../../../ai/bad-request";
import { isBookStepError, type BookStepBase } from "./base";

/**
 * A provider failure's exchange-log message: `bad_request` (a request the provider refused as malformed, see BadRequestError) or
 * `failed`, then, for a {@link ProviderError} only (the provider's own error text, never a reply), its message as one line without paths
 * ("failed" alone hid a 400).
 */
export const providerFailMessage = (error: unknown): string => {
  const text = isProviderError(error) ? providerErrorText(error) : "";
  const code = isBadRequest(error) ? "bad_request" : "failed";
  return text ? `${code}: ${text}` : code;
};

/** What a plan step's exchange-log entry says when it fails: a fixed code for a bad reply (never the model's reply), else {@link providerFailMessage}. */
export const planFailMessage = (error: unknown): string =>
  isBookStepError(error) ? "invalid_reply" : providerFailMessage(error);

/**
 * One text-only plan call (whole-book plan or one card's brief): no tools, no web, the budget reserved before the provider is
 * asked, and nothing of the prompt or reply in the exchange log (`noContentLog`). The caller's retry loop owns attempts.
 */
export async function runPlanStep<Request extends BookStepBase, Output>(
  aiCalls: AiCalls,
  step: StepDefinition<Request, Output>,
  request: Request,
  run: { signal: AbortSignal; admission?: AdmissionContext; topic?: string }
): Promise<Output> {
  const prepared = prepareStep(step, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: run.topic ?? "Book pipeline plan",
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
