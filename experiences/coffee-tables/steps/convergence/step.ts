import { renderTemplate, type StepDefinition } from "../../../../core/step-runner";
import { coffeeInstruction, coffeeText } from "../../language";
import { enforcePinnedProposals } from "../../convergence";
import {
  observerGuidance,
  parseConvergenceProposals,
  type CoffeeConvergenceProposal,
  type CoffeeCustomization
} from "../../customization";
import type { CoffeeInsight } from "../../insights";
import { MAX_COFFEE_CONTEXT_CHARS } from "../../prompt-parts";
import type { CoffeeSession } from "../../types";
import { DETAIL_LEVEL, MERGE_LEVEL } from "../_shared/fragments";
import en from "./prompt.en.md";
import zh from "./prompt.zh.md";

export interface ConvergenceInput {
  session: CoffeeSession;
  baseline: CoffeeInsight[];
  customization: CoffeeCustomization;
}

function variables({ session, baseline, customization }: ConvergenceInput): Record<string, string> {
  const pinned = new Set(session.pinnedInsightIds ?? []);
  const items = baseline.map(item => ({
    id: item.id,
    category: item.category,
    summary: item.summary,
    detail: item.detail,
    sources: item.sources,
    question: item.question,
    proposedSolution: item.proposedSolution,
    limitations: item.limitations,
    pinned: pinned.has(item.id)
  }));
  const key = coffeeInstruction(session.language);
  const level = MERGE_LEVEL[key][customization.mergeLevel];
  const detail = DETAIL_LEVEL[key][customization.detailLevel];
  return {
    guidance: observerGuidance(session.language, customization),
    level,
    detail,
    customPrompt: customization.convergencePrompt.trim(),
    pinned: JSON.stringify([...pinned]),
    items: JSON.stringify(items)
  };
}

/** The whole JSON contract: proposal shape (against the baseline IDs) plus the pinned-insight rule. */
export function parseConvergenceResponse(
  raw: string,
  { session, baseline }: Pick<ConvergenceInput, "session" | "baseline">
): CoffeeConvergenceProposal[] {
  const proposals = parseConvergenceProposals(
    raw,
    baseline.map(item => item.id)
  );
  enforcePinnedProposals(proposals, baseline, session.pinnedInsightIds ?? []);
  return proposals;
}

/**
 * Insight convergence. `parse` is the whole JSON contract (proposal shape plus the pinned-insight rule). The engine
 * calls it after its own stale-generation, abort and streamed-fallback checks, so it uses `StepRunner.send`.
 */
export const convergenceStep: StepDefinition<ConvergenceInput, CoffeeConvergenceProposal[]> = {
  id: "coffee.convergence",
  version: 1,
  render: input => renderTemplate(coffeeInstruction(input.session.language) === "zh" ? zh : en, variables(input)),
  policy: (prompt, input) => {
    if (prompt.length > MAX_COFFEE_CONTEXT_CHARS)
      throw new Error(coffeeText(input.session.language, "coffee.insights_too_long_to_preview"));
  },
  parse: (raw, input) => parseConvergenceResponse(raw, input)
};
