import { normalizeRelevanceContext, normalizeRelevanceGoal, type RelevanceTier } from "../../note-values";

/**
 * Pure rules for pinned (hand-set) relevance tiers: the bounds a pin puts on the cards around it, the parent-child
 * check over the merged result, and which mode a grade click runs in. No obsidian, no I/O, no AI.
 */

/** A card in the shape the grade steps use (a subset of `StructureNode`; only the structure matters here). */
export interface PinTreeNode {
  id: string;
  parentId: string | null;
}
export interface RelevancePin {
  id: string;
  tier: RelevanceTier;
}
/** One card ranked above its parent (core > support > side), or outside the bounds its pins give it. */
export interface TierViolation {
  childId: string;
  childTier: RelevanceTier;
  parentId: string;
  parentTier: RelevanceTier;
}
/** The tiers a non-pinned card may take because of the pins around it; a missing side is unbounded. */
export interface PinBound {
  min?: RelevanceTier;
  max?: RelevanceTier;
  /** The pinned card that gives the lower bound (a descendant) and the upper bound (an ancestor). */
  minBy?: string;
  maxBy?: string;
}
/** A pinned card ranked above a pinned ancestor, both set by the learner. The edges between them are exempt. */
export interface PinConflict {
  ancestorId: string;
  ancestorTier: RelevanceTier;
  descendantId: string;
  descendantTier: RelevanceTier;
  /** Card ids from the ancestor down to the descendant, both included. */
  path: string[];
}
export interface RelevancePinBounds {
  /** Only cards whose range is narrower than "anything"; pinned and top-level cards have none. */
  bounds: Map<string, PinBound>;
  /** Child ids whose edge to their parent is exempt from the parent-child rule (the path between conflicting pins). */
  exemptEdges: Set<string>;
  conflicts: PinConflict[];
}

export const TIER_RANK: Record<RelevanceTier, number> = { core: 2, support: 1, side: 0 };
const TIER_BY_RANK: RelevanceTier[] = ["side", "support", "core"];

/**
 * Bounds from the pins. Top-level cards (parentId null) are context and take no part, as in the parent-child rule.
 * A pin forces its ancestors to at least its tier and its descendants to at most its tier. When a pinned card ranks
 * above a pinned ancestor (the learner's own choice), every parent-child edge on the path between the two is exempt
 * from the rule, the AI cards in between get no lower bound, and their upper bound is the pinned ancestor's tier.
 * The tree is parent before child.
 */
export function relevancePinBounds(
  tree: ReadonlyArray<PinTreeNode>,
  pins: ReadonlyArray<RelevancePin>
): RelevancePinBounds {
  const nodes = new Map(tree.map(node => [node.id, node]));
  const gradable = (id: string | null): boolean => id !== null && nodes.get(id)?.parentId !== null && nodes.has(id);
  const pinTier = new Map<string, RelevanceTier>();
  for (const pin of pins) if (gradable(pin.id)) pinTier.set(pin.id, pin.tier);
  const result: RelevancePinBounds = { bounds: new Map(), exemptEdges: new Set(), conflicts: [] };
  if (!pinTier.size) return result;
  // Conflicts: every pinned card against its nearest pinned ancestor (a violation anywhere up the chain implies one here).
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
      if (TIER_RANK[ancestorTier] < TIER_RANK[tier]) {
        result.conflicts.push({
          ancestorId: id,
          ancestorTier,
          descendantId: node.id,
          descendantTier: tier,
          path
        });
        for (const child of path.slice(1)) result.exemptEdges.add(child);
      }
      break;
    }
  }
  const children = new Map<string, string[]>();
  for (const node of tree)
    if (gradable(node.id) && node.parentId)
      children.set(node.parentId, [...(children.get(node.parentId) ?? []), node.id]);
  // Lower bound: the highest pinned card below, reached through edges that are not exempt (children before parents).
  const low = new Map<string, { rank: number; by: string }>();
  for (const node of [...tree].reverse()) {
    if (!gradable(node.id) || pinTier.has(node.id)) continue;
    let best: { rank: number; by: string } | undefined;
    for (const child of children.get(node.id) ?? []) {
      if (result.exemptEdges.has(child)) continue;
      const tier = pinTier.get(child);
      const candidate = tier ? { rank: TIER_RANK[tier], by: child } : low.get(child);
      if (candidate && (!best || candidate.rank > best.rank)) best = candidate;
    }
    if (best) low.set(node.id, best);
  }
  // Upper bound: the nearest pinned ancestor's tier, or the bound the AI parent already has (parents before children).
  const high = new Map<string, { rank: number; by: string }>();
  for (const node of tree) {
    if (!gradable(node.id) || pinTier.has(node.id) || !node.parentId || !gradable(node.parentId)) continue;
    const parentTier = pinTier.get(node.parentId);
    const candidate = parentTier ? { rank: TIER_RANK[parentTier], by: node.parentId } : high.get(node.parentId);
    if (candidate) high.set(node.id, candidate);
  }
  for (const node of tree) {
    if (!gradable(node.id) || pinTier.has(node.id)) continue;
    let min = low.get(node.id);
    const max = high.get(node.id);
    // Cannot happen once the conflicting edges are exempt; never hand the model an empty range.
    if (min && max && min.rank > max.rank) min = undefined;
    const bound: PinBound = {
      ...(min && min.rank > 0 ? { min: TIER_BY_RANK[min.rank], minBy: min.by } : {}),
      ...(max && max.rank < 2 ? { max: TIER_BY_RANK[max.rank], maxBy: max.by } : {})
    };
    if (bound.min || bound.max) result.bounds.set(node.id, bound);
  }
  return result;
}

/**
 * Every card ranked above its parent (edges the pins exempted are not compared; a top-level parent is context), then
 * every non-pinned card outside its bounds that is not already listed. Map order. `tiers` is the merged result: the
 * previous grades, the AI's changes and the pins on top.
 */
export function relevanceMergedViolations(
  tree: ReadonlyArray<PinTreeNode>,
  tiers: ReadonlyMap<string, RelevanceTier>,
  pins?: RelevancePinBounds
): TierViolation[] {
  const found: TierViolation[] = [];
  const key = new Set<string>();
  const add = (violation: TierViolation): void => {
    const id = `${violation.childId}|${violation.parentId}`;
    if (key.has(id)) return;
    key.add(id);
    found.push(violation);
  };
  for (const node of tree) {
    if (node.parentId === null || pins?.exemptEdges.has(node.id)) continue;
    const parentTier = tiers.get(node.parentId);
    const tier = tiers.get(node.id);
    if (parentTier && tier && TIER_RANK[tier] > TIER_RANK[parentTier])
      add({ childId: node.id, childTier: tier, parentId: node.parentId, parentTier });
  }
  if (pins)
    for (const node of tree) {
      const bound = pins.bounds.get(node.id);
      const tier = tiers.get(node.id);
      if (!bound || !tier) continue;
      if (bound.min && bound.minBy && TIER_RANK[tier] < TIER_RANK[bound.min]) {
        const by = tiers.get(bound.minBy);
        if (by) add({ childId: bound.minBy, childTier: by, parentId: node.id, parentTier: tier });
      }
      if (bound.max && bound.maxBy && TIER_RANK[tier] > TIER_RANK[bound.max]) {
        const by = tiers.get(bound.maxBy);
        if (by) add({ childId: node.id, childTier: tier, parentId: bound.maxBy, parentTier: by });
      }
    }
  return found;
}

/** The final tier of every card: previous grades, then the AI's items on top, then the pins on top of those. */
export function mergeRelevanceTiers(parts: {
  previous?: Iterable<RelevancePin>;
  items?: Iterable<RelevancePin>;
  pins?: Iterable<RelevancePin>;
}): Map<string, RelevanceTier> {
  const merged = new Map<string, RelevanceTier>();
  for (const list of [parts.previous, parts.items, parts.pins])
    for (const entry of list ?? []) merged.set(entry.id, entry.tier);
  return merged;
}

/**
 * The floor for cards the goal-suggest list just added: a suggested card the model graded "side" is raised to
 * "support" when its merged parent is a top-level card or at least "support". Never lowers a card, never touches a
 * pinned or a non-suggested card, and leaves a card under a "side" (or ungraded) parent alone, because a card never
 * ranks above its parent. Lives only in this call; nothing is stored.
 */
export function floorSuggestedTiers<T extends RelevancePin>(
  tree: ReadonlyArray<PinTreeNode>,
  previous: Iterable<RelevancePin>,
  items: ReadonlyArray<T>,
  pins: ReadonlyArray<RelevancePin>,
  suggested: ReadonlySet<string>
): T[] {
  if (!suggested.size) return [...items];
  const nodes = new Map(tree.map(node => [node.id, node]));
  const merged = mergeRelevanceTiers({ previous, items, pins });
  const pinned = new Set(pins.map(pin => pin.id));
  const bounds = relevancePinBounds(tree, pins).bounds;
  return items.map(item => {
    if (!suggested.has(item.id) || pinned.has(item.id) || merged.get(item.id) !== "side") return item;
    const parentId = nodes.get(item.id)?.parentId ?? null;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (!parent) return item;
    if (parent.parentId !== null) {
      const parentTier = merged.get(parent.id);
      if (!parentTier || TIER_RANK[parentTier] < TIER_RANK.support) return item;
    }
    const max = bounds.get(item.id)?.max;
    if (max && TIER_RANK[max] < TIER_RANK.support) return item;
    return { ...item, tier: "support" as const };
  });
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
  return new Map([...tree].filter(node => raised.has(node.id)).map(node => [node.id, raised.get(node.id) as RelevanceTier]));
}

// ---- Which button the panel offers -------------------------------------------------------------------------

export interface RelevanceSetupDraft {
  goal: string;
  context: string;
}
export interface RelevanceSetupSaved {
  goal?: string;
  context?: string;
}
export type RelevanceMode = "recalibrate" | "full";

/**
 * True when the panel's draft equals the saved goal and context, compared the way the repository stores them
 * (`writeRelevanceGoal`: whitespace collapsed, trimmed, capped; a blank context is none).
 */
export function relevanceSetupUnchanged(draft: RelevanceSetupDraft, saved: RelevanceSetupSaved): boolean {
  const goal = normalizeRelevanceGoal(draft.goal);
  if (!goal) return false;
  return (
    goal === normalizeRelevanceGoal(saved.goal ?? "") &&
    normalizeRelevanceContext(draft.context) === normalizeRelevanceContext(saved.context ?? "")
  );
}
/** Recalibrate only when nothing in the setup changed and the map already holds an AI grade; otherwise grade it all. */
export function relevanceMode(
  draft: RelevanceSetupDraft,
  saved: RelevanceSetupSaved,
  hasAiGrades: boolean
): RelevanceMode {
  return hasAiGrades && relevanceSetupUnchanged(draft, saved) ? "recalibrate" : "full";
}
/** The mode after the goal was written: the repository's own `setupChanged` has the last word. */
export function relevanceModeAfterWrite(planned: RelevanceMode, setupChanged: boolean): RelevanceMode {
  return planned === "recalibrate" && !setupChanged ? "recalibrate" : "full";
}
