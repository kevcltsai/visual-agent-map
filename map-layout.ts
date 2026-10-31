import { parentIdsForNode, type MapNode } from "./map-graph";

const COLUMN = 360;
const WIDTH = 300;
/** Vertical space kept between two stacked cards, in canvas units. */
export const LAYOUT_GAP = 24;
/** Card height assumed when the rendered height is unknown (not yet rendered or hidden). */
export const DEFAULT_CARD_HEIGHT = 180;

/** Which way a map's branches grow from their root: "right" (the original layout) or "left" (the root on the right). */
export type LayoutDirection = "right" | "left";

/** A map's stored layout choice; absent means "right". */
export interface MapLayout {
  direction: LayoutDirection;
}

export function isLayoutDirection(value: unknown): value is LayoutDirection {
  return value === "right" || value === "left";
}

/** The direction a map is laid out in. AIM maps always grow to the right; a missing or unknown choice is "right". */
export function layoutDirectionOf(map: { layout?: MapLayout; aim?: unknown } | null | undefined): LayoutDirection {
  if (!map || map.aim) return "right";
  const direction = map.layout?.direction;
  return isLayoutDirection(direction) ? direction : "right";
}

/** +1 when columns grow to the right, -1 when they grow to the left. */
const signOf = (direction: LayoutDirection): number => (direction === "left" ? -1 : 1);

/** Rendered card height in canvas units, or undefined when unknown. */
export type HeightOf = (id: string) => number | undefined;

/** Typical card height from measured ones (median of the positive finite values); undefined when none. */
export function medianHeight(values: number[]): number | undefined {
  const sorted = values.filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const cardHeight = (heightOf: HeightOf | undefined, id: string): number => {
  const value = heightOf?.(id);
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : DEFAULT_CARD_HEIGHT;
};

function positions(
  nodes: MapNode[],
  roots: MapNode[],
  left: number,
  top: number,
  folded = false,
  heightOf?: HeightOf,
  direction: LayoutDirection = "right"
): Map<string, { x: number; y: number }> {
  const sign = signOf(direction);
  const ids = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, MapNode[]>();
  const joins = new Map<string, MapNode[]>();
  const add = (map: Map<string, MapNode[]>, key: string, node: MapNode) =>
    map.set(key, [...(map.get(key) ?? []), node]);
  for (const node of nodes) {
    if (!node.parentId) continue;
    // A conclusion converging on sibling sources joins after all of them instead of hanging under one.
    const sources =
      node.aimKind !== "question" && node.aimConvergesFromNodeIds?.length
        ? parentIdsForNode(node).map(id => ids.get(id))
        : [];
    const anchor = sources[0]?.parentId;
    if (anchor && ids.has(anchor) && sources.every(source => source && source.parentId === anchor))
      add(joins, anchor, node);
    else add(children, node.parentId, node);
  }
  const result = new Map<string, { x: number; y: number }>();
  const kidsOf = (node: MapNode) => (folded && node.collapsed ? [] : (children.get(node.id) ?? []));
  const joinsOf = (node: MapNode) =>
    folded && node.collapsed
      ? []
      : (joins.get(node.id) ?? []).filter(join => !(folded && ids.get(join.parentId!)?.collapsed));
  const heightFor = (node: MapNode) => cardHeight(heightOf, node.id);
  const sizes = new Map<string, number>();
  const spans = new Map<string, number>();
  /** Total height of stacked subtrees, with the fixed gap between neighbours. */
  const stackHeight = (list: MapNode[]) =>
    list.reduce((total, item) => total + sizes.get(item.id)!, 0) + Math.max(0, list.length - 1) * LAYOUT_GAP;
  const measure = (node: MapNode): void => {
    const kids = kidsOf(node);
    const extra = joinsOf(node);
    for (const child of [...kids, ...extra]) measure(child);
    sizes.set(node.id, Math.max(heightFor(node), stackHeight(kids), stackHeight(extra)));
    spans.set(node.id, 1 + Math.max(0, ...kids.map(kid => spans.get(kid.id)!)));
  };
  /** Places a subtree inside the band starting at topY; returns the card's top y. */
  const place = (node: MapNode, depth: number, topY: number): number => {
    const kids = kidsOf(node);
    const extra = joinsOf(node);
    const size = sizes.get(node.id)!;
    const stack = (list: MapNode[], column: number) => {
      let next = topY + (size - stackHeight(list)) / 2;
      return list.map(item => {
        const y = place(item, column, next);
        next += sizes.get(item.id)! + LAYOUT_GAP;
        return y;
      });
    };
    const kidYs = stack(kids, depth + 1);
    const joinYs = stack(extra, depth + spans.get(node.id)!);
    const list = kidYs.length ? kids : extra;
    const ys = kidYs.length ? kidYs : joinYs;
    const own = heightFor(node);
    let y = topY + (size - own) / 2;
    if (ys.length) {
      const first = ys[0] + heightFor(list[0]) / 2;
      const last = ys[ys.length - 1] + heightFor(list[list.length - 1]) / 2;
      y = (first + last) / 2 - own / 2;
    }
    result.set(node.id, { x: left + sign * depth * COLUMN, y: top + y });
    return y;
  };
  let offset = 0;
  for (const root of roots) {
    measure(root);
    place(root, 0, offset);
    offset += sizes.get(root.id)! + LAYOUT_GAP;
  }
  return result;
}

/** Lays out what is on screen: a collapsed topic is a leaf, and its hidden branch keeps its coordinates until it is shown again. */
export function arrangeMap(
  nodes: MapNode[],
  hidden?: Set<string>,
  heightOf?: HeightOf,
  direction: LayoutDirection = "right"
): MapNode[] {
  const laidOut = hidden?.size ? nodes.filter(node => !hidden.has(node.id)) : nodes;
  const roots = laidOut.filter(node => !node.parentId);
  const placed = positions(laidOut, roots, 80, 80, true, heightOf, direction);
  return nodes.map(node => ({ ...node, ...placed.get(node.id) }));
}

export function arrangeNewBranch(
  nodes: MapNode[],
  parentId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  /** The new branch's top edge starts at or below this y (before collision avoidance); undefined keeps the centred start. */
  minTop?: number,
  direction: LayoutDirection = "right"
): MapNode[] {
  const parent = nodes.find(node => node.id === parentId);
  if (!parent || !newIds.size) return nodes;
  const fresh = nodes.filter(node => newIds.has(node.id));
  const roots = fresh.filter(node => node.parentId === parentId);
  const placed = positions(fresh, roots, parent.x + signOf(direction) * COLUMN, 0, false, heightOf, direction);
  const centers = roots.map(root => placed.get(root.id)!.y + cardHeight(heightOf, root.id) / 2);
  const center = centers.length ? (Math.min(...centers) + Math.max(...centers)) / 2 : 0;
  let offset = parent.y + cardHeight(heightOf, parent.id) / 2 - center;
  if (minTop !== undefined && placed.size)
    offset = Math.max(offset, minTop - Math.min(...[...placed.values()].map(point => point.y)));
  const fixed = nodes.filter(node => !newIds.has(node.id));
  for (;;) {
    let next = offset;
    for (const [id, point] of placed) {
      const own = cardHeight(heightOf, id);
      for (const node of fixed) {
        const other = cardHeight(heightOf, node.id);
        const top = point.y + offset;
        if (Math.abs(point.x - node.x) < WIDTH && top < node.y + other + LAYOUT_GAP && node.y < top + own + LAYOUT_GAP)
          next = Math.max(next, node.y + other + LAYOUT_GAP - point.y);
      }
    }
    if (next === offset) break;
    offset = next;
  }
  return nodes.map(node => {
    const point = placed.get(node.id);
    return point ? { ...node, x: point.x, y: Math.round(point.y + offset) } : node;
  });
}

/** Lays out a new top-level tree below every existing node, in the leftmost root column; existing nodes never move. */
export function arrangeNewTree(
  nodes: MapNode[],
  rootId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  direction: LayoutDirection = "right"
): MapNode[] {
  const root = nodes.find(node => node.id === rootId);
  if (!root || !newIds.has(rootId)) return nodes;
  const fixed = nodes.filter(node => !newIds.has(node.id));
  const fixedRoots = fixed.filter(node => !node.parentId);
  const left = Math.min(...(fixedRoots.length ? fixedRoots : fixed).map(node => node.x), fixed.length ? Infinity : 80);
  const top = fixed.length ? Math.max(...fixed.map(node => node.y + cardHeight(heightOf, node.id))) + LAYOUT_GAP : 80;
  const placed = positions(
    nodes.filter(node => newIds.has(node.id)),
    [root],
    left,
    top,
    false,
    heightOf,
    direction
  );
  return nodes.map(node => {
    const point = placed.get(node.id);
    return point ? { ...node, x: point.x, y: Math.round(point.y) } : node;
  });
}
