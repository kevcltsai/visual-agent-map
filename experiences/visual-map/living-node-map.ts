import { planLivingNodes, type LivingNodePlanNode } from "./living-node-plan";
import { isAiCard } from "./prompt-run";
import {
  createLivingSourceResolver,
  type LivingSourceNode,
  type LivingSourcePort,
  type LivingSourceRef
} from "./living-node-sources";

export interface LivingMapCard extends LivingNodePlanNode, LivingSourceNode {
  explicitRefs: readonly LivingSourceRef[];
}

/** Resolve each card's source set once from a single map snapshot before the execution graph is planned. */
export function planLivingMap(
  cards: readonly LivingMapCard[],
  mapLinks: readonly string[],
  port: LivingSourcePort,
  requested?: readonly string[]
) {
  const resolve = createLivingSourceResolver(cards, port);
  const sources = new Map<string, ReturnType<typeof resolve>>();
  const nodes = cards.map(card => {
    if (!isAiCard(card)) return card;
    const resolved = resolve(card.id, card.explicitRefs, mapLinks);
    sources.set(card.id, resolved);
    return {
      ...card,
      explicitCardIds: resolved.dependencyIds,
      sourceUnavailable: resolved.failures.some(failure => failure.required)
    };
  });
  return { plan: planLivingNodes(nodes, requested), sources };
}
