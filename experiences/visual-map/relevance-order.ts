import { arrangeMap, type LayoutKind, type MapLayout } from "../../map-layout";
import type { MapNode } from "../../map-model";
import type { RelevanceTier } from "../../note-values";

const RANK: Record<RelevanceTier, number> = { core: 0, support: 1, side: 2 };
const UNGRADED = 3;

/**
 * Display order of one sibling group: core, support, side, ungraded; cards of the same tier keep their current
 * (on-screen) order. Pure: the input is never changed and nothing is persisted.
 */
export function orderSiblingsByRelevance(
  siblings: MapNode[],
  tierOf: (id: string) => RelevanceTier | undefined
): MapNode[] {
  const rank = (node: MapNode): number => {
    const tier = tierOf(node.id);
    return tier ? RANK[tier] : UNGRADED;
  };
  const current = siblings
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.y - b.node.y || a.node.x - b.node.x || a.index - b.index);
  return current.sort((a, b) => rank(a.node) - rank(b.node)).map(item => item.node);
}

/**
 * Copies of `nodes` with display positions: every sibling group (same parent, and the top level) is ordered by
 * relevance and the map is laid out on screen with that order. Parents never change, and the result is only a view:
 * callers must not write it back.
 */
export function relevanceDisplayNodes(
  nodes: MapNode[],
  tierOf: (id: string) => RelevanceTier | undefined,
  hidden?: Set<string>,
  direction: LayoutKind | MapLayout = "right"
): MapNode[] {
  const groups = new Map<string | null, MapNode[]>();
  for (const node of nodes) {
    const key = node.parentId ?? null;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  const slot = new Map<string, number>();
  for (const group of groups.values())
    orderSiblingsByRelevance(group, tierOf).forEach((node, index) => slot.set(node.id, index));
  const sequenced = nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => slot.get(a.node.id)! - slot.get(b.node.id)! || a.index - b.index)
    .map(item => item.node);
  const laidOut = arrangeMap(sequenced, hidden, undefined, direction);
  const placed = new Map(laidOut.map(node => [node.id, node]));
  return nodes.map(node => ({ ...node, x: placed.get(node.id)!.x, y: placed.get(node.id)!.y }));
}
