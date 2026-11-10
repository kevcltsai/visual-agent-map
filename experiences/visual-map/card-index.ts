import type { MapNode } from "../../map-graph";

/**
 * Lookups a paint of the map's cards shares, built once when the paint starts and dropped when it ends (like the child index
 * next to it), so drawing N cards never scans the whole map per card or per ancestor.
 */
export interface CardIndex {
  /** The map node with this id: the first one in map order, as `nodes.find` would give. */
  node(id: string): MapNode | undefined;
  /** Nesting level of a topic, 1 for a root. See `cardIndex` for a missing parent and a corrupt parent cycle. */
  depth(node: MapNode): number;
}

/**
 * Indexes `nodes` by id (first wins) and memoizes depths. A depth counts each step up the parent chain: a parent id that is
 * not on the map still counts as one level, and a corrupt cycle stops when the walk would revisit a topic, so a topic in a
 * cycle of k topics is at level k and one j steps below that cycle at level j + k.
 */
export function cardIndex(nodes: readonly MapNode[]): CardIndex {
  const byId = new Map<string, MapNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const depths = new Map<string, number>();
  const depth = (start: MapNode): number => {
    // A display copy that is not on the map is walked like any topic but never remembered under its id.
    const indexed = byId.get(start.id) === start;
    if (indexed) {
      const known = depths.get(start.id);
      if (known !== undefined) return known;
    }
    // Walk up until a known depth, the top, a missing parent or a revisit; then fill in the chain from the top down.
    const chain: MapNode[] = [start];
    const at = new Map([[start.id, 0]]);
    let base = 0;
    for (;;) {
      const parentId = chain[chain.length - 1].parentId;
      if (!parentId) break;
      const known = depths.get(parentId);
      if (known !== undefined) {
        base = known;
        break;
      }
      const repeat = at.get(parentId);
      if (repeat !== undefined) {
        // Every topic in the cycle walks it once around: its level is the cycle's length.
        const cycle = chain.length - repeat;
        for (let i = repeat; i < chain.length; i++) if (i > 0 || indexed) depths.set(chain[i].id, cycle);
        chain.length = repeat;
        base = cycle;
        break;
      }
      const parent = byId.get(parentId);
      if (!parent) {
        base = 1;
        break;
      }
      at.set(parentId, chain.length);
      chain.push(parent);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      base += 1;
      if (i > 0 || indexed) depths.set(chain[i].id, base);
    }
    return base;
  };
  return { node: id => byId.get(id), depth };
}
