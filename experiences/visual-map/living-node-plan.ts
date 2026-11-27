import { isAiCard, type PromptNoteRef, type PromptNodeRef } from "./prompt-run";

/** Resolved same-map references only; ordinary Markdown sources are read-only inputs, not execution edges. */
export interface LivingNodePlanNode extends PromptNodeRef, PromptNoteRef {
  explicitCardIds?: readonly string[];
  /** Required note references that could not be resolved or authorized. */
  sourceUnavailable?: boolean;
  hasKnowledge: boolean;
}

export type LivingNodeBlockReason = "missing-source" | "locked-without-knowledge" | "dependency-blocked" | "cycle";

export interface LivingNodePlan {
  /** In dependency order; validity is evaluated at dispatch, after dependencies have settled. */
  order: { id: string; forced: boolean }[];
  blocked: Map<string, LivingNodeBlockReason>;
  /** Locked explicit Run Card targets never execute. */
  lockedTargets: string[];
  /** Frozen, readable dependencies reached by the runnable plan. */
  frozen: string[];
  /** Exact required AI dependencies, including frozen ones, by consumer. */
  dependencies: Map<string, readonly string[]>;
}

function graph(nodes: readonly LivingNodePlanNode[]) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId == null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const sources = (id: string): string[] => [
    ...new Set([...(children.get(id) ?? []), ...(byId.get(id)?.explicitCardIds ?? [])])
  ];
  return { byId, sources };
}

/** Kahn traversal: stable insertion order, iterative even for deep or corrupt maps. */
function topology(edges: ReadonlyMap<string, readonly string[]>) {
  const consumers = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  const ready: string[] = [];
  for (const [id, deps] of edges) {
    remaining.set(id, deps.length);
    if (!deps.length) ready.push(id);
    for (const dep of deps) {
      const list = consumers.get(dep) ?? [];
      list.push(id);
      consumers.set(dep, list);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    for (const id of consumers.get(ready[i]) ?? []) {
      const count = (remaining.get(id) ?? 0) - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  return {
    order: ready,
    unresolved: [...remaining].filter(([, count]) => count > 0).map(([id]) => id)
  };
}

/** Check proposed structural/config changes without treating a lock as permission to introduce a cycle. */
function cycleAffected(nodes: readonly LivingNodePlanNode[]): Set<string> {
  const { byId, sources } = graph(nodes);
  const edges = new Map<string, string[]>();
  for (const node of nodes) {
    if (!isAiCard(node)) continue;
    edges.set(
      node.id,
      sources(node.id).filter(id => id === node.id || isAiCard(byId.get(id)))
    );
  }
  return new Set(topology(edges).unresolved);
}

export function hasLivingNodeCycle(nodes: readonly LivingNodePlanNode[]): boolean {
  return cycleAffected(nodes).size > 0;
}

/**
 * Plan the reachable candidates for Run Card, or every unlocked AI card for Run All.
 * Ordinary cards stop execution edges. A lock freezes just that card, not independently targeted descendants.
 * No provider calls or writes happen here. Unresolved ordinary Vault paths are checked by the source resolver.
 */
export function planLivingNodes(nodes: readonly LivingNodePlanNode[], requested?: readonly string[]): LivingNodePlan {
  const { byId, sources } = graph(nodes);
  const cyclic = cycleAffected(nodes);
  const targets = new Set<string>();
  const lockedTargets: string[] = [];
  for (const id of new Set(requested ?? nodes.map(node => node.id))) {
    const node = byId.get(id);
    if (!isAiCard(node)) continue;
    if (node?.aiLocked) {
      if (requested) lockedTargets.push(id);
    } else targets.add(id);
  }
  const edges = new Map<string, string[]>();
  const blocked = new Map<string, LivingNodeBlockReason>();
  const frozenByCard = new Map<string, string[]>();
  const pending = [...targets];
  const discovered = new Set(pending);
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i];
    if (byId.get(id)?.sourceUnavailable) blocked.set(id, "missing-source");
    const deps: string[] = [];
    const frozen: string[] = [];
    for (const sourceId of sources(id)) {
      const source = byId.get(sourceId);
      if (!source) {
        blocked.set(id, "missing-source");
        continue;
      }
      if (!isAiCard(source)) continue;
      if (source.aiLocked) {
        if (!source.hasKnowledge) blocked.set(id, "locked-without-knowledge");
        else frozen.push(sourceId);
        continue;
      }
      deps.push(sourceId);
      if (!discovered.has(sourceId)) {
        discovered.add(sourceId);
        pending.push(sourceId);
      }
    }
    if (cyclic.has(id)) blocked.set(id, "cycle");
    edges.set(id, deps);
    frozenByCard.set(id, frozen);
  }
  const sorted = topology(edges);
  for (const id of sorted.unresolved) {
    if (!blocked.has(id)) blocked.set(id, "cycle");
  }
  for (const id of sorted.order) {
    if (!blocked.has(id) && edges.get(id)?.some(dep => blocked.has(dep))) blocked.set(id, "dependency-blocked");
  }
  // Do not dispatch dependencies needed only by an already-blocked target. Shared valid branches still run.
  const required = new Set<string>();
  const runnable = [...targets].filter(id => !blocked.has(id));
  const frozen = new Set<string>();
  for (let i = 0; i < runnable.length; i++) {
    const id = runnable[i];
    if (required.has(id)) continue;
    required.add(id);
    for (const dep of edges.get(id) ?? []) runnable.push(dep);
    for (const dep of frozenByCard.get(id) ?? []) frozen.add(dep);
  }
  return {
    order: sorted.order.filter(id => required.has(id)).map(id => ({ id, forced: targets.has(id) })),
    blocked,
    lockedTargets,
    frozen: [...frozen],
    dependencies: new Map(
      sorted.order
        .filter(id => required.has(id))
        .map(id => [id, [...(edges.get(id) ?? []), ...(frozenByCard.get(id) ?? [])]])
    )
  };
}

/** Evaluate after upstream settlement so a successful no-op can clear derived staleness. */
export function shouldRunLivingNode(forced: boolean, validity: "none" | "valid" | "stale"): boolean {
  return forced || validity !== "valid";
}
