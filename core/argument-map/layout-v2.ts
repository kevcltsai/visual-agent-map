/**
 * Version 2 argument map arrangement (methodology 6, mockup "Version 2"). Pure: no vault, no UI. The tree is the parent links the flow
 * already wrote: proposition -> (premises group, conclusion); the premises group -> premise claims -> their data; the conclusion ->
 * claims to test -> (the comparison card first, then the hypotheses) -> evidence. This only decides the ORDER of each card's children and
 * lets the ordinary "right" engine place them. `LayoutKind` is not touched and nothing is stored. The version 1 arrangement
 * (`layout.ts`) stays as it is for legacy maps.
 */
import type { MapNode } from "../../map-graph";
import { arrangeMap, cardsOverlapAny, type HeightOf } from "../../map-layout";
import type { ArgumentMapData, Need, PremiseDatum } from "./model";

/** Found evidence first (supports, refutes, then the rest), then the dashed missing ones (searching, pending, not found). */
function needRank(need: Need): number {
  if (need.state === "found") return need.assessment?.stance === "supports" ? 0 : need.assessment?.stance === "refutes" ? 1 : 2;
  return 3 + (need.state === "searching" ? 0 : need.state === "pending" ? 1 : 2);
}
function datumRank(datum: PremiseDatum): number {
  if (datum.state === "found") return datum.stance === "opposes" ? 1 : 0;
  return 3 + (datum.state === "searching" ? 0 : datum.state === "pending" ? 1 : 2);
}

/** The rank of each node among its siblings (lower first); a node the flow does not know keeps rank 0 and so its saved order. */
export function siblingRanksV2(state: ArgumentMapData): Map<string, number> {
  const rank = new Map<string, number>();
  const key = (group: number, index: number): number => group * 1000 + index;
  rank.set(state.roles.premises, 0);
  rank.set(state.roles.conclusion, 1);
  state.claims.forEach((claim, index) => {
    rank.set(claim.id, index);
    if (claim.comparison) rank.set(claim.comparison.nodeId, key(0, 0));
    (claim.data ?? []).forEach((datum, at) => rank.set(datum.id, key(datumRank(datum), at)));
  });
  state.hypotheses.forEach((h, index) => {
    rank.set(h.id, key(1, index));
    h.needs.forEach((need, at) => rank.set(need.id, key(needRank(need), at)));
  });
  return rank;
}

/** Siblings the flow knows are sorted by rank and then by the state's own order; any other sibling keeps its saved order. */
export function orderArgumentNodesV2(nodes: readonly MapNode[], state: ArgumentMapData): MapNode[] {
  const rank = siblingRanksV2(state);
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
 * Arranges the whole version 2 argument map to the right. Positions only: ids, parents and every other field come back untouched and in
 * the original array order. A card's own branch layout is ignored (the map is always "right"). `hidden` cards stay where they are.
 */
export function arrangeArgumentMapV2(
  nodes: MapNode[],
  state: ArgumentMapData,
  heightOf?: HeightOf,
  options: { hidden?: Set<string> } = {}
): MapNode[] {
  const ordered = orderArgumentNodesV2(nodes, state).map(node => {
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

/** A usable version 2 map whose cards overlap is arranged once with the default height; null when nothing needs to move. */
export function arrangeUnarrangedArgumentMapV2(nodes: MapNode[], state: ArgumentMapData): MapNode[] | null {
  const all = new Set(nodes.map(node => node.id));
  if (!cardsOverlapAny(nodes, all, () => UNARRANGED_PROBE_HEIGHT)) return null;
  return arrangeArgumentMapV2(nodes, state);
}
