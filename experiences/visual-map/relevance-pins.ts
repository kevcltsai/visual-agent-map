import type { RelevanceTier } from "../../note-values";

/**
 * Pure rules for relevance tiers: which hand-set pins disagree with each other, and which cards a child's tier forces up.
 * No obsidian, no I/O, no AI.
 */

/** A card in the shape the recommend step uses (a subset of `StructureNode`; only the structure matters here). */
export interface PinTreeNode {
  id: string;
  parentId: string | null;
}
export interface RelevancePin {
  id: string;
  tier: RelevanceTier;
}
/** A pinned card ranked above a pinned ancestor, both set by the learner. Told to the learner, never changed. */
export interface PinConflict {
  ancestorId: string;
  ancestorTier: RelevanceTier;
  descendantId: string;
  descendantTier: RelevanceTier;
  /** Card ids from the ancestor down to the descendant, both included. */
  path: string[];
}

const TIER_RANK: Record<RelevanceTier, number> = { core: 2, support: 1, side: 0 };
const TIER_BY_RANK: RelevanceTier[] = ["side", "support", "core"];

/**
 * Every pinned card ranked above its nearest pinned ancestor (the learner's own choice; reported, never fixed). Top-level
 * cards (parentId null) are context and take no part. The tree is parent before child.
 */
export function relevancePinConflicts(
  tree: ReadonlyArray<PinTreeNode>,
  pins: ReadonlyArray<RelevancePin>
): PinConflict[] {
  const nodes = new Map(tree.map(node => [node.id, node]));
  const gradable = (id: string | null): boolean => id !== null && nodes.get(id)?.parentId !== null && nodes.has(id);
  const pinTier = new Map<string, RelevanceTier>();
  for (const pin of pins) if (gradable(pin.id)) pinTier.set(pin.id, pin.tier);
  const conflicts: PinConflict[] = [];
  // Every pinned card against its nearest pinned ancestor (a violation anywhere up the chain implies one here).
  for (const node of tree) {
    const tier = pinTier.get(node.id);
    if (!tier) continue;
    const path = [node.id];
    const seen = new Set(path);
    for (let id = node.parentId; id && gradable(id) && !seen.has(id); id = nodes.get(id)?.parentId ?? null) {
      seen.add(id);
      path.unshift(id);
      const ancestorTier = pinTier.get(id);
      if (!ancestorTier) continue;
      if (TIER_RANK[ancestorTier] < TIER_RANK[tier])
        conflicts.push({ ancestorId: id, ancestorTier, descendantId: node.id, descendantTier: tier, path });
      break;
    }
  }
  return conflicts;
}

/**
 * A card never ranks below what it holds: raise every non-frozen, tiered, non-top-level card to at least the highest tier
 * among its descendants. Pure: returns only the cards that change (id -> new tier), in map order. `tiers` is the merged
 * result (previous grades plus the AI's items plus pins). A frozen card (pinned by hand, locked, outside the AI's view)
 * keeps its tier, but the height of its descendants keeps passing up to its ancestors. A card without a tier is never
 * given one here; it passes the height up too. Top-level cards are context and are never raised. The tree is parent
 * before child.
 */
export function raiseParents(
  tree: ReadonlyArray<PinTreeNode>,
  tiers: ReadonlyMap<string, RelevanceTier>,
  frozen: ReadonlySet<string>
): Map<string, RelevanceTier> {
  const below = new Map<string, number>();
  const raised = new Map<string, RelevanceTier>();
  for (const node of [...tree].reverse()) {
    if (node.parentId === null) continue;
    const own = tiers.get(node.id);
    let up = Math.max(own === undefined ? -1 : TIER_RANK[own], below.get(node.id) ?? -1);
    const need = below.get(node.id) ?? -1;
    if (own !== undefined && !frozen.has(node.id) && need > TIER_RANK[own]) {
      raised.set(node.id, TIER_BY_RANK[need]);
      up = need;
    }
    below.set(node.parentId, Math.max(below.get(node.parentId) ?? -1, up));
  }
  return new Map(
    [...tree].filter(node => raised.has(node.id)).map(node => [node.id, raised.get(node.id) as RelevanceTier])
  );
}
