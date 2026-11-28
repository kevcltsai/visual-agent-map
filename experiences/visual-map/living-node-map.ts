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
      sourceUnavailable: card.sourceUnavailable || resolved.failures.some(failure => failure.required)
    };
  });
  return { plan: planLivingNodes(nodes, requested), sources };
}

/** Per runnable AI card: the planner's own dependencies (run) and the ordinary same-map cards it reads (read). */
export interface LivingDependencyGraph {
  run: ReadonlyMap<string, readonly string[]>;
  read: ReadonlyMap<string, readonly string[]>;
}

/** Built once from a whole-map plan; a blocked or cyclic card has no entry, so it highlights nothing. */
export function livingDependencyGraph(
  cards: readonly LivingMapCard[],
  planned: ReturnType<typeof planLivingMap>
): LivingDependencyGraph {
  const ai = new Set(cards.filter(isAiCard).map(card => card.id));
  const read = new Map<string, string[]>();
  for (const id of planned.plan.dependencies.keys()) {
    const plainCards = (planned.sources.get(id)?.sources ?? []).flatMap(source =>
      source.cardId && !ai.has(source.cardId) && source.roles.some(role => role !== "map") ? [source.cardId] : []
    );
    if (plainCards.length) read.set(id, plainCards);
  }
  return { run: planned.plan.dependencies, read };
}

/** The consumer-dependency pairs a selected card depends on, walking run edges upstream; each pair once. */
export function livingHighlight(
  graph: LivingDependencyGraph,
  id: string
): { run: [string, string][]; read: [string, string][] } {
  const run: [string, string][] = [];
  const read: [string, string][] = [];
  if (!graph.run.has(id)) return { run, read };
  const pending = [id];
  const seen = new Set(pending);
  for (let i = 0; i < pending.length; i++) {
    const consumer = pending[i];
    for (const dep of graph.read.get(consumer) ?? []) read.push([consumer, dep]);
    for (const dep of graph.run.get(consumer) ?? []) {
      run.push([consumer, dep]);
      // A locked dependency has no entry of its own: it is listed, not expanded.
      if (!seen.has(dep) && graph.run.has(dep)) {
        seen.add(dep);
        pending.push(dep);
      }
    }
  }
  return { run, read };
}

/** A structural/config edit may repair an old cycle or leave an unrelated old
 * cycle alone. It may not add an edge that closes a new cycle, even if every
 * affected node was already blocked by another cycle.
 */
export function introducesLivingCycle(
  before: readonly LivingMapCard[],
  after: readonly LivingMapCard[],
  port: LivingSourcePort
): boolean {
  const edges = (cards: readonly LivingMapCard[]): Map<string, Set<string>> => {
    const ai = new Set(cards.filter(isAiCard).map(card => card.id));
    const resolve = createLivingSourceResolver(cards, port);
    const graph = new Map<string, Set<string>>();
    for (const card of cards) {
      if (!ai.has(card.id)) continue;
      const resolved = resolve(card.id, card.explicitRefs, []);
      graph.set(card.id, new Set(resolved.dependencyIds.filter(id => ai.has(id))));
    }
    return graph;
  };
  const previous = edges(before);
  const proposed = edges(after);
  for (const [consumer, dependencies] of proposed) {
    for (const dependency of dependencies) {
      if (previous.get(consumer)?.has(dependency)) continue;
      const pending = [dependency];
      const seen = new Set<string>();
      for (let i = 0; i < pending.length; i++) {
        const id = pending[i];
        if (id === consumer) return true;
        if (seen.has(id)) continue;
        seen.add(id);
        for (const next of proposed.get(id) ?? []) if (!seen.has(next)) pending.push(next);
      }
    }
  }
  return false;
}
