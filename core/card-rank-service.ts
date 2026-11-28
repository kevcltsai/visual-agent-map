import type { AdmissionContext } from "./admission";
import type { AiCalls } from "./ai-calls";
import { stepEffort } from "./provider-step-runner";
import { prepareStep } from "./step-runner";
import { cardRankStep, type CardRankRequest } from "./steps/card-rank/step";

export { CARD_RANK_LIMIT, CARD_RANK_MAX_CARDS, CARD_RANK_EXCERPT_CHARS } from "./steps/card-rank/step";
export type { CardRankCandidate, CardRankRequest } from "./steps/card-rank/step";

export function buildCardRankPrompt(request: CardRankRequest): string {
  return cardRankStep.render(request);
}

/**
 * One AI call that orders found cards by meaning (V3.3 P4.1). The call is reserved against `admission` right before it is sent
 * (a refusal is `BudgetExhaustedError`, nothing is sent); the exchange log keeps no content (the cards are the owner's writing).
 * Resolves to the offered ids, best first.
 */
export async function runCardRank(
  aiCalls: AiCalls,
  request: CardRankRequest,
  run: { signal: AbortSignal; admission: AdmissionContext }
): Promise<string[]> {
  const prepared = prepareStep(cardRankStep, request);
  return aiCalls.run(
    prepared,
    {
      model: request.model,
      effort: stepEffort(request.reasoning),
      topic: "Rank found cards",
      taskName: "card-rank",
      signal: run.signal,
      localCodex: true,
      noContentLog: true,
      failMessage: () => "failed",
      usage: { action: "other", mapPath: request.usageMapPath },
      admission: run.admission,
      task: { textOnly: true, searchBudget: 0, timeoutMs: 20 * 1000 }
    },
    raw => prepared.parse(raw)
  );
}
