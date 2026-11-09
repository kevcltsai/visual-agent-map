/**
 * Argument map arrangement (plan section 5). Pure: no vault, no UI. The five layers (proposition, situation or conclusion,
 * the two groups, hypotheses, evidence) are the parent links the flow already wrote, so this only decides the ORDER of
 * each card's children and then lets the ordinary "right" engine place them. `LayoutKind` is not touched and nothing
 * is stored: a map without a usable `argumentMap` never comes here.
 */
import type { MapNode } from "../../map-graph";
import { arrangeMap, cardsOverlapAny, type HeightOf } from "../../map-layout";
import { isVerified, type ArgumentMapData, type Hypothesis, type Need, type SituationDatum } from "./model";

const GROUP_STANCE = { supports: 0, contradicts: 1, opposes: 1, uncertain: 2 } as const;
/** Found items first (supports, then contradicts, then uncertain), then the dashed missing ones (searching, pending, not found). */
function itemRank(item: Need | SituationDatum): number {
  if (item.state === "found") return GROUP_STANCE[item.stance ?? "uncertain"];
  return 3 + (item.state === "searching" ? 0 : item.state === "pending" ? 1 : 2);
}

/** Where a hypothesis stands among its siblings: verified first, then the ones still verifying, in the order they were proposed. */
function hypothesisRank(h: Hypothesis): number {
  return isVerified(h) ? 0 : 1;
}

/**
 * The rank of each node among its siblings (lower first); nodes the flow does not know keep rank 0 and so their saved
 * order (the sort is stable). Pure function of the state.
 */
export function siblingRanks(state: ArgumentMapData): Map<string, number> {
  const rank = new Map<string, number>();
  const { roles } = state;
  rank.set(roles.situation, 0);
  rank.set(roles.conclusion, 1);
  rank.set(roles.verified, 0);
  rank.set(roles.eliminated, 1);
  // Rank first, then the order the state lists them in (so the picture does not depend on the node array's order).
  const key = (group: number, index: number): number => group * 1000 + index;
  state.hypotheses.forEach((h, index) => {
    rank.set(h.id, key(hypothesisRank(h), index));
    h.needs.forEach((need, at) => rank.set(need.id, key(itemRank(need), at)));
  });
  state.situation.data.forEach((datum, index) => rank.set(datum.id, key(itemRank(datum), index)));
  return rank;
}

/** Siblings the flow knows are sorted by rank and then by the state's own order; any other sibling keeps its saved order. */
export function orderArgumentNodes(nodes: readonly MapNode[], state: ArgumentMapData): MapNode[] {
  const rank = siblingRanks(state);
  const slots = new Map<string, number[]>();
  nodes.forEach((node, index) => slots.set(node.parentId ?? "", [...(slots.get(node.parentId ?? "") ?? []), index]));
  const out = [...nodes];
  for (const indexes of slots.values()) {
    // Array.prototype.sort is stable: equal ranks keep their saved order.
    const sorted = indexes.map(i => nodes[i]).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    indexes.forEach((slot, i) => (out[slot] = sorted[i]));
  }
  return out;
}

/**
 * Arranges the whole argument map to the right, children ordered by role and stance. Positions only: ids, parents and
 * every other field come back untouched and in the original array order. A card's own branch layout is ignored (the
 * map is always "right"). `hidden` cards are left where they are, like `arrangeMap`.
 */
export function arrangeArgumentMap(
  nodes: MapNode[],
  state: ArgumentMapData,
  heightOf?: HeightOf,
  options: { hidden?: Set<string> } = {}
): MapNode[] {
  const ordered = orderArgumentNodes(nodes, state).map(node => {
    const copy = { ...node };
    delete copy.layout;
    return copy;
  });
  const placed = new Map(arrangeMap(ordered, options.hidden, heightOf, "right", { reset: true }).map(n => [n.id, n]));
  return nodes.map(node => {
    const at = placed.get(node.id);
    return at ? { ...node, x: at.x, y: at.y } : node;
  });
}

/** Cards this short still overlap only when they are stacked (nothing was ever arranged), so a saved arrangement is left alone. */
const UNARRANGED_PROBE_HEIGHT = 40;

/**
 * A usable argument map whose cards overlap (the flow placed them, nobody arranged them) is arranged once, with the default card
 * height so the result does not depend on what is drawn. Returns the arranged nodes, or null when nothing needs to move; the result
 * overlaps nothing, so arranging it again returns null (no endless writes).
 */
export function arrangeUnarrangedArgumentMap(nodes: MapNode[], state: ArgumentMapData): MapNode[] | null {
  const all = new Set(nodes.map(node => node.id));
  if (!cardsOverlapAny(nodes, all, () => UNARRANGED_PROBE_HEIGHT)) return null;
  return arrangeArgumentMap(nodes, state);
}
