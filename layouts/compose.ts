import { sideFromOffset } from "./balanced";

/** The arrangements a single branch may use of its own. */
export type BranchDirection = "right" | "left" | "down" | "up";

export function isBranchDirection(value: unknown): value is BranchDirection {
  return value === "right" || value === "left" || value === "down" || value === "up";
}

/** The map arrangements in which branches may have their own (decision D9); the others ignore branch layouts. */
export function allowsBranchLayout(mapDirection: string): boolean {
  return (
    mapDirection === "right" ||
    mapDirection === "left" ||
    mapDirection === "down" ||
    mapDirection === "up" ||
    mapDirection === "balanced"
  );
}

/** The branch layout of a card, or undefined: a root has none and anything but the four directions is not one. */
export function branchDirectionOf(
  node: { parentId?: string | null; layout?: unknown } | undefined
): BranchDirection | undefined {
  if (!node?.parentId) return undefined;
  const layout = node.layout;
  if (!layout || typeof layout !== "object" || Array.isArray(layout)) return undefined;
  const direction = (layout as { direction?: unknown }).direction;
  return isBranchDirection(direction) ? direction : undefined;
}

const sideOf = (dx: number): BranchDirection | undefined => sideFromOffset(dx);

/**
 * Deletes every branch layout in `nodes` that cannot be used, so a hand-edited or old file never reaches the arranger:
 * a layout that is not an object with one of the four directions (extra keys are dropped), one on a root, and one that
 * points opposite the direction its parent grows in. A parent grows in the nearest branch layout above it, else the map's
 * direction; in a balanced map it grows towards the side its first-level topic stands on, and a topic too close to the
 * root to have a side is not checked. Maps that do not allow branch layouts keep valid values (they are ignored when
 * arranging, and come back into effect when the map goes back to a direction that allows them) without the opposite
 * check. An AIM map keeps no branch layouts. `nodes` must have no cycle and no missing parent.
 */
export function cleanBranchLayouts<T extends { id: string; parentId?: string | null; x: number; layout?: unknown }>(
  nodes: T[],
  mapDirection: string,
  aim = false
): void {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const done = new Set<string>();
  const directionAbove = (id: string, from: T): string | undefined => {
    const own = layoutDirectionIn(byId, id, undefined);
    if (own) return own;
    if (mapDirection !== "balanced") return allowsBranchLayout(mapDirection) ? mapDirection : undefined;
    let topic: T | undefined = from;
    while (topic?.parentId && byId.get(topic.parentId)?.parentId) topic = byId.get(topic.parentId);
    const root = topic?.parentId ? byId.get(topic.parentId) : undefined;
    return topic && root ? sideOf(topic.x - root.x) : undefined;
  };
  const clean = (node: T): void => {
    done.add(node.id);
    if (node.layout === undefined) return;
    const direction = aim ? undefined : branchDirectionOf(node);
    if (!direction) {
      delete node.layout;
      return;
    }
    const above = directionAbove(node.parentId!, node);
    if (isBranchDirection(above) && direction === oppositeDirection(above)) delete node.layout;
    else node.layout = { direction };
  };
  for (const node of nodes) {
    const chain: T[] = [];
    for (let at: T | undefined = node; at && !done.has(at.id); at = at.parentId ? byId.get(at.parentId) : undefined)
      chain.push(at);
    for (const item of chain.reverse()) clean(item);
  }
}

/** The nearest branch layout at or above `id`, else `fallback`. */
function layoutDirectionIn<T extends { id: string; parentId?: string | null; layout?: unknown }>(
  byId: Map<string, T>,
  id: string,
  fallback: string | undefined
): string | undefined {
  const seen = new Set<string>();
  for (
    let node = byId.get(id);
    node && !seen.has(node.id);
    node = node.parentId ? byId.get(node.parentId) : undefined
  ) {
    seen.add(node.id);
    const own = branchDirectionOf(node);
    if (own) return own;
  }
  return fallback;
}

/**
 * The direction the cards below `id` grow in: the layout of the nearest card at or above it that has its own branch
 * layout, else `mapDirection`. Maps that do not allow branch layouts always answer `mapDirection`.
 */
export function layoutDirectionFor<T extends { id: string; parentId?: string | null; layout?: unknown }>(
  nodes: T[],
  id: string,
  mapDirection: string
): string {
  if (!allowsBranchLayout(mapDirection)) return mapDirection;
  return layoutDirectionIn(new Map(nodes.map(node => [node.id, node])), id, mapDirection) ?? mapDirection;
}

export const oppositeDirection = (direction: BranchDirection): BranchDirection =>
  direction === "right" ? "left" : direction === "left" ? "right" : direction === "down" ? "up" : "down";

/** What the composer needs from an engine call and from the tree; the caller decides what is collapsed or joined. */
export interface ComposeInput<T extends { id: string; parentId?: string | null; layout?: unknown }> {
  roots: T[];
  kidsOf: (node: T) => T[];
  joinsOf: (node: T) => T[];
  heightFor: (node: T) => number;
  /** Card width, the same for every card. */
  width: number;
  /** Horizontal distance between neighbouring cards in a down or up arrangement. */
  column: number;
  mapDirection: string;
  /** Arranges `roots` and everything below them in `direction`, treating the given kids, joins and heights as the tree. */
  engine: (
    direction: string,
    tree: {
      roots: T[];
      kidsOf: (node: T) => T[];
      joinsOf: (node: T) => T[];
      heightFor: (node: T) => number;
    }
  ) => Map<string, { x: number; y: number }>;
}

type Point = { x: number; y: number };

/**
 * Arranges a map in which some branches have a layout of their own. Each such branch is arranged by itself in its own
 * direction (branches inside it likewise) and then stands in the parent's arrangement as one card as large as the
 * block: as tall as the block in a right, left or balanced parent, as wide as the block (in whole columns) in a down or
 * up parent. The block is then put on the side the parent grows towards: its near edge on the column of the card it
 * replaces (right, left, balanced), or its top edge (bottom edge for up) on that card's row, centred on the slot (down,
 * up). Cards outside the blocks are exactly where the parent's arrangement alone puts them.
 */
export function composePositions<T extends { id: string; parentId?: string | null; layout?: unknown }>(
  input: ComposeInput<T>
): Map<string, Point> {
  const { width, column, mapDirection, engine } = input;
  const arrange = (roots: T[], direction: string): Map<string, Point> => {
    const heads: { node: T; root: T }[] = [];
    const walk = (node: T, root: T): void => {
      for (const child of [...input.kidsOf(node), ...input.joinsOf(node)]) {
        if (branchDirectionOf(child)) heads.push({ node: child, root });
        else walk(child, root);
      }
    };
    for (const root of roots) walk(root, root);
    const tree = { roots, kidsOf: input.kidsOf, joinsOf: input.joinsOf, heightFor: input.heightFor };
    if (!heads.length) return engine(direction, tree);
    const vertical = direction === "down" || direction === "up";
    const blocks = heads.map(({ node, root }) => {
      const placed = arrange([node], branchDirectionOf(node)!);
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      const byId = new Map<string, T>();
      const collect = (item: T): void => {
        byId.set(item.id, item);
        for (const child of [...input.kidsOf(item), ...input.joinsOf(item)]) collect(child);
      };
      collect(node);
      for (const [id, point] of placed) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x + width);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y + input.heightFor(byId.get(id)!));
      }
      // A down or up parent gives the block whole slots of one column each, plus the usual space between cards.
      const slots = Math.max(1, Math.ceil((maxX - minX + column - width) / column));
      return { node, root, placed, minX, maxX, minY, maxY, slots };
    });
    const byHead = new Map(blocks.map(block => [block.node.id, block]));
    const padOf = (node: T): T[] => {
      const block = byHead.get(node.id);
      if (!block || !vertical) return [];
      return Array.from({ length: block.slots }, (_, index) => ({ id: `${node.id}\u0000pad${index}` }) as T);
    };
    const pads = new Set<string>();
    const outer = {
      roots,
      kidsOf: (node: T) => {
        if (!byHead.has(node.id)) return input.kidsOf(node);
        const list = padOf(node);
        for (const item of list) pads.add(item.id);
        return list;
      },
      joinsOf: (node: T) => (byHead.has(node.id) ? [] : input.joinsOf(node)),
      heightFor: (node: T) => {
        if (pads.has(node.id)) return 0;
        const block = byHead.get(node.id);
        return block && !vertical ? block.maxY - block.minY : input.heightFor(node);
      }
    };
    const placed = engine(direction, outer);
    const result = new Map<string, Point>();
    for (const [id, point] of placed) if (!pads.has(id) && !byHead.has(id)) result.set(id, point);
    for (const block of blocks) {
      const at = placed.get(block.node.id)!;
      let dx: number, dy: number;
      if (vertical) {
        // The block is centred on the slots it takes; the head card stands in the middle one.
        dx = at.x + column / 2 - (block.minX + block.maxX) / 2;
        dy = direction === "down" ? at.y - block.minY : at.y + input.heightFor(block.node) - block.maxY;
      } else {
        const toRight =
          direction === "right" || (direction === "balanced" && at.x >= (placed.get(block.root.id)?.x ?? at.x));
        dx = toRight ? at.x - block.minX : at.x + width - block.maxX;
        dy = at.y - block.minY;
      }
      for (const [id, point] of block.placed) result.set(id, { x: point.x + dx, y: point.y + dy });
    }
    return result;
  };
  return arrange(input.roots, mapDirection);
}
