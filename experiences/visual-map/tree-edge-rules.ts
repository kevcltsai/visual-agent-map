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

export function depthOf(nodes: MapNode[], id: string): number {
  const byId = new Map(nodes.map(node => [node.id, node]));
  let depth = 0;
  // A topic that follows a text block hangs one step lower: its line starts at the block, which hangs on the real parent.
  for (let node = byId.get(id); node?.parentId && depth < nodes.length; node = byId.get(node.parentId))
    depth += node.afterTextId ? 2 : 1;
  return depth;
}
