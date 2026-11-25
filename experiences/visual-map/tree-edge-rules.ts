// Pure rules for how a tree line is drawn, shared by the map view and the share viewer (which cannot import the view).
import { allowsBranchLayout, branchDirectionOf } from "../../layouts/compose";
import type { MapNode } from "../../map-graph";

/** `layoutDirectionFor` for many ids at once: builds the id lookup one time and remembers each answer. */
export function branchDirectionResolver(
  nodes: MapNode[],
  mapDirection: string,
  /** Text block id -> the topic it hangs on: a block takes the direction of its topic (an unknown id is the whole map's). */
  texts?: ReadonlyMap<string, string>,
  /** Ring members and the way they grow (away from their picture); they win over every branch layout. */
  rings?: ReadonlyMap<string, string>
): (id: string) => string {
  const layered = allowsBranchLayout(mapDirection);
  if (!layered && !rings?.size) return () => mapDirection;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const known = new Map<string, string>();
  const resolve = (id: string, seen: Set<string>): string => {
    const hit = known.get(id);
    if (hit !== undefined) return hit;
    const textParent = texts?.get(id);
    if (textParent !== undefined && !byId.has(id)) {
      const answer = resolve(textParent, seen);
      known.set(id, answer);
      return answer;
    }
    const node = byId.get(id);
    let answer = mapDirection;
    if (node && !seen.has(id)) {
      seen.add(id);
      answer =
        rings?.get(id) ??
        (layered ? branchDirectionOf(node) : undefined) ??
        (node.parentId ? resolve(node.parentId, seen) : mapDirection);
    }
    known.set(id, answer);
    return answer;
  };
  return id => resolve(id, new Set());
}
/**
 * The arrangement a tree line is drawn in. In a fishbone the line from a text block to the topic that follows it is a
 * straight line between the two boxes (like a radial line): the block hangs beside its topic's bone, so a rib on the bone
 * would never touch the block.
 */
export function lineKind(nodes: MapNode[], fromId: string, childId: string, direction: string): string {
  return direction === "fishbone" && nodes.find(node => node.id === childId)?.afterTextId === fromId
    ? "radial"
    : direction;
}

export function depthOf(
  nodes: MapNode[],
  id: string,
  byId: ReadonlyMap<string, MapNode> = new Map(nodes.map(node => [node.id, node]))
): number {
  let depth = 0;
  // A topic that follows a text block hangs one step lower: its line starts at the block, which hangs on the real parent.
  for (let node = byId.get(id); node?.parentId && depth < nodes.length; node = byId.get(node.parentId))
    depth += node.afterTextId ? 2 : 1;
  return depth;
}

/** One edge pass or drag setup: build the id index only if a depth is needed, then reuse each measured depth. */
export function treeDepthResolver(nodes: MapNode[], index?: ReadonlyMap<string, MapNode>): (id: string) => number {
  let byId = index;
  const known = new Map<string, number>();
  return id => {
    const cached = known.get(id);
    if (cached !== undefined) return cached;
    byId ??= new Map(nodes.map(node => [node.id, node]));
    // Cache only complete, acyclic paths. The old bounded walk defines the result of corrupt cycles
    // and weighted depths that reach its limit; do not use those truncated values as ancestor depths.
    const chain: MapNode[] = [];
    const seen = new Set<string>();
    let depth = 0;
    let node = byId.get(id);
    while (node?.parentId) {
      const cached = known.get(node.id);
      if (cached !== undefined) {
        depth = cached;
        break;
      }
      if (seen.has(node.id)) return depthOf(nodes, id, byId);
      seen.add(node.id);
      chain.push(node);
      node = byId.get(node.parentId);
    }
    for (let at = chain.length - 1; at >= 0; at--) {
      depth += chain[at].afterTextId ? 2 : 1;
      if (depth > nodes.length) return depthOf(nodes, id, byId);
      known.set(chain[at].id, depth);
    }
    known.set(id, depth);
    return depth;
  };
}

/** One synchronous geometry pass: measure a DOM endpoint once. A new pass always reads fresh boxes. */
export function edgeBoxReader<Element, Box>(measure: (element: Element) => Box): (element: Element) => Box {
  const boxes = new Map<Element, Box>();
  return element => {
    if (!boxes.has(element)) boxes.set(element, measure(element));
    return boxes.get(element)!;
  };
}
