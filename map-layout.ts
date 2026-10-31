import { assignSides, greedySides, sideFromOffset, type BalancedSide } from "./layouts/balanced";
import { allowsBranchLayout, branchDirectionOf, composePositions, layoutDirectionFor } from "./layouts/compose";
import { fishbonePositions } from "./layouts/fishbone";
import { radialPositions } from "./layouts/radial";
import { timelinePositions } from "./layouts/timeline";
import { verticalPositions } from "./layouts/vertical";
import { parentIdsForNode, type MapNode } from "./map-graph";

const WIDTH = 300;
/** Vertical space kept between two stacked cards at the standard spacing, in canvas units. */
export const LAYOUT_GAP = 24;

/** How tightly cards are packed: column distance and the gap between stacked cards, in canvas units. */
export type LayoutSpacing = "compact" | "standard" | "spacious";

const SPACING: Record<LayoutSpacing, { column: number; gap: number }> = {
  compact: { column: 330, gap: 12 },
  standard: { column: 360, gap: LAYOUT_GAP },
  spacious: { column: 420, gap: 48 }
};

/** The spacings a map file may store; "standard" is the default and is never written. */
export function isStoredLayoutSpacing(value: unknown): value is "compact" | "spacious" {
  return value === "compact" || value === "spacious";
}
/** Card height assumed when the rendered height is unknown (not yet rendered or hidden). */
export const DEFAULT_CARD_HEIGHT = 180;

/** Which way a map's branches grow from their root: "right" (the original layout) or "left" (the root on the right). */
export type LayoutDirection = "right" | "left";

/** Every arrangement the data format can name; engines other than right and left arrive one packet at a time. */
export type LayoutKind = LayoutDirection | "down" | "up" | "balanced" | "radial" | "timeline" | "fishbone";

/** A map's stored layout choice; absent means "right" at standard spacing. */
export interface MapLayout {
  direction: LayoutKind;
  spacing?: LayoutSpacing;
}

/** The arrangements a map file may store: every one of them has an engine. */
export function isLayoutKind(value: unknown): value is LayoutKind {
  return (
    value === "right" ||
    value === "left" ||
    value === "down" ||
    value === "up" ||
    value === "balanced" ||
    value === "radial" ||
    value === "timeline" ||
    value === "fishbone"
  );
}

/** The direction the cards below a card grow in: the nearest branch layout at or above it, else the map's direction. */
export { layoutDirectionFor };

export function isLayoutDirection(value: unknown): value is LayoutDirection {
  return value === "right" || value === "left";
}

/** The direction a map is laid out in. AIM maps always grow to the right; a missing or unknown choice is "right". */
export function layoutDirectionOf(map: { layout?: MapLayout; aim?: unknown } | null | undefined): LayoutDirection {
  if (!map || map.aim) return "right";
  const direction = map.layout?.direction;
  return isLayoutDirection(direction) ? direction : "right";
}

/** The full layout choice of a map (direction and spacing). AIM maps always grow to the right at standard spacing. */
export function layoutOf(map: { layout?: MapLayout; aim?: unknown } | null | undefined): MapLayout {
  const stored = map && !map.aim ? map.layout?.direction : undefined;
  const direction: LayoutKind = isLayoutKind(stored) ? stored : "right";
  const spacing = map && !map.aim ? map.layout?.spacing : undefined;
  return isStoredLayoutSpacing(spacing) ? { direction, spacing } : { direction };
}

/** Direction, column distance and card gap an arrange call works with; a bare direction string means standard spacing. */
function resolveLayout(layout: LayoutKind | MapLayout): { direction: LayoutKind; column: number; gap: number } {
  const direction = typeof layout === "string" ? layout : layout.direction;
  const spacing = typeof layout === "string" ? undefined : layout.spacing;
  return { direction, ...SPACING[isStoredLayoutSpacing(spacing) ? spacing : "standard"] };
}

const isVertical = (direction: LayoutKind): boolean => direction === "down" || direction === "up";

/** +1 when columns grow to the right, -1 when they grow to the left. */
const signOf = (direction: LayoutKind): number => (direction === "left" ? -1 : 1);

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

/** The parent-to-children structure of a node list; the caller decides what is collapsed or joined. */
function structureOf(nodes: MapNode[], folded: boolean) {
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
  const kidsOf = (node: MapNode) => (folded && node.collapsed ? [] : (children.get(node.id) ?? []));
  const joinsOf = (node: MapNode) =>
    folded && node.collapsed
      ? []
      : (joins.get(node.id) ?? []).filter(join => !(folded && ids.get(join.parentId!)?.collapsed));
  return { kidsOf, joinsOf };
}

interface HorizontalInput {
  roots: MapNode[];
  kidsOf: (node: MapNode) => MapNode[];
  joinsOf: (node: MapNode) => MapNode[];
  heightFor: (node: MapNode) => number;
  column: number;
  gap: number;
  /** +1 grows columns to the right, -1 to the left. */
  sign: number;
  left: number;
  top: number;
}

/** The right and left engine: depth decides x, siblings stack along y, a parent is centred beside its children. */
function horizontalPositions(input: HorizontalInput): {
  placed: Map<string, { x: number; y: number }>;
  sizes: Map<string, number>;
} {
  const { roots, kidsOf, joinsOf, heightFor, column: COLUMN, gap: LAYOUT_GAP, sign, left, top } = input;
  const result = new Map<string, { x: number; y: number }>();
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
  return { placed: result, sizes };
}

/**
 * Balanced: each root's first-level topics are split between a right half and a left half (see `assignSides`), each half
 * is laid out with the right or left engine, and the root card sits between them. All roots share one x.
 * `reset` ignores where the topics stand now and deals them out again.
 */
function balancedPositions(
  nodes: MapNode[],
  input: HorizontalInput,
  reset: boolean
): Map<string, { x: number; y: number }> {
  const { roots, kidsOf, joinsOf, heightFor, column, gap, left, top } = input;
  const sizes = horizontalPositions({ ...input, sign: 1 }).sizes;
  const byId = new Map(nodes.map(node => [node.id, node]));
  const halves = roots.map(root => {
    const rootNode = byId.get(root.id) ?? root;
    const sides = assignSides(
      kidsOf(root),
      topic => sizes.get(topic.id)!,
      gap,
      topic => (reset ? undefined : sideFromOffset((byId.get(topic.id) ?? topic).x - rootNode.x))
    );
    const half = (side: BalancedSide) =>
      horizontalPositions({
        ...input,
        roots: [root],
        kidsOf: node => (node.id === root.id ? kidsOf(node).filter(kid => sides.get(kid.id) === side) : kidsOf(node)),
        joinsOf: node => (node.id === root.id && side === "left" ? [] : joinsOf(node)),
        sign: side === "left" ? -1 : 1,
        left: 0,
        top: 0
      }).placed;
    return { root, right: half("right"), left: half("left") };
  });
  const reach = Math.max(
    0,
    ...halves.flatMap(({ left: placed }) => [...placed.values()].map(point => Math.round(-point.x / column)))
  );
  const rootX = left + reach * column;
  const result = new Map<string, { x: number; y: number }>();
  let offset = 0;
  for (const { root, right, left: leftHalf } of halves) {
    const centreOf = (placed: Map<string, { x: number; y: number }>) => placed.get(root.id)!.y + heightFor(root) / 2;
    const middle = Math.max(centreOf(right), centreOf(leftHalf));
    const entries: [string, { x: number; y: number }][] = [];
    for (const half of [
      { placed: right, isLeft: false },
      { placed: leftHalf, isLeft: true }
    ]) {
      const { placed, isLeft } = half;
      const shift = middle - centreOf(placed);
      for (const [id, point] of placed)
        if (!(isLeft && id === root.id)) entries.push([id, { x: rootX + point.x, y: point.y + shift }]);
    }
    const heightOfId = (id: string) => heightFor(byId.get(id)!);
    const first = Math.min(...entries.map(([, point]) => point.y));
    const last = Math.max(...entries.map(([id, point]) => point.y + heightOfId(id)));
    for (const [id, point] of entries) result.set(id, { x: point.x, y: top + offset + point.y - first });
    offset += last - first + gap;
  }
  return result;
}

function positions(
  nodes: MapNode[],
  roots: MapNode[],
  left: number,
  top: number,
  folded = false,
  heightOf?: HeightOf,
  layout: LayoutKind | MapLayout = "right",
  reset = false
): Map<string, { x: number; y: number }> {
  const { direction, column: COLUMN, gap: LAYOUT_GAP } = resolveLayout(layout);
  const { kidsOf, joinsOf } = structureOf(nodes, folded);
  const heightFor = (node: MapNode) => cardHeight(heightOf, node.id);
  type Tree = {
    roots: MapNode[];
    kidsOf: (node: MapNode) => MapNode[];
    joinsOf: (node: MapNode) => MapNode[];
    heightFor: (node: MapNode) => number;
  };
  /** One arrangement for the given tree; branches with their own layout call this once per direction. */
  const engine = (kind: string, tree: Tree): Map<string, { x: number; y: number }> => {
    if (kind === "down" || kind === "up")
      return verticalPositions({ ...tree, column: COLUMN, rowGap: COLUMN - WIDTH, flip: kind === "up", left, top });
    const flat = { ...tree, column: COLUMN, gap: LAYOUT_GAP, left, top };
    if (kind === "radial") return radialPositions({ ...flat, width: WIDTH });
    if (kind === "timeline") return timelinePositions({ ...flat, width: WIDTH });
    if (kind === "fishbone") return fishbonePositions({ ...flat, width: WIDTH });
    const input = { ...flat, sign: signOf(kind as LayoutKind) };
    if (kind === "balanced") return balancedPositions(nodes, input, reset);
    return horizontalPositions(input).placed;
  };
  const tree = { roots, kidsOf, joinsOf, heightFor };
  // Branches with a layout of their own are arranged as blocks (decision D9); the other maps ignore them.
  if (allowsBranchLayout(direction) && nodes.some(node => branchDirectionOf(node)))
    return composePositions({ ...tree, width: WIDTH, column: COLUMN, mapDirection: direction, engine });
  return engine(direction, tree);
}

/** Lays out what is on screen: a collapsed topic is a leaf, and its hidden branch keeps its coordinates until it is shown again. */
export function arrangeMap(
  nodes: MapNode[],
  hidden?: Set<string>,
  heightOf?: HeightOf,
  layout: LayoutKind | MapLayout = "right"
): MapNode[] {
  const laidOut = hidden?.size ? nodes.filter(node => !hidden.has(node.id)) : nodes;
  const roots = laidOut.filter(node => !node.parentId);
  const placed = positions(laidOut, roots, 80, 80, true, heightOf, layout);
  return nodes.map(node => ({ ...node, ...placed.get(node.id) }));
}

/** Radial, timeline and fishbone maps lay the whole map out again when a branch is added; hand-placed cards are reset (decision D5). */
function rearrangeWhole(nodes: MapNode[], heightOf: HeightOf | undefined, layout: LayoutKind | MapLayout): MapNode[] {
  const roots = nodes.filter(node => !node.parentId);
  if (!roots.length) return nodes;
  const placed = positions(nodes, roots, 80, 80, true, heightOf, layout);
  // The first root stays where it is, so adding a topic does not make the whole map jump.
  const anchor = roots[0];
  const dx = anchor.x - placed.get(anchor.id)!.x;
  const dy = anchor.y - placed.get(anchor.id)!.y;
  return nodes.map(node => {
    const point = placed.get(node.id);
    if (!point || node.id === anchor.id) return node;
    return { ...node, x: Math.round(point.x + dx), y: Math.round(point.y + dy) };
  });
}

/** A new branch in a down or up map: one row below (above) the parent, centred under it, sliding along x past older cards. */
function arrangeVerticalBranch(
  nodes: MapNode[],
  parent: MapNode,
  fresh: MapNode[],
  roots: MapNode[],
  newIds: Set<string>,
  heightOf: HeightOf | undefined,
  layout: LayoutKind | MapLayout
): MapNode[] {
  const { direction, column: COLUMN, gap: LAYOUT_GAP } = resolveLayout(layout);
  const placed = positions(fresh, roots, 0, 0, false, heightOf, layout);
  const rootCentres = roots.map(root => placed.get(root.id)!.x + WIDTH / 2);
  const middle = rootCentres.length ? (Math.min(...rootCentres) + Math.max(...rootCentres)) / 2 : WIDTH / 2;
  let shiftX = parent.x + WIDTH / 2 - middle;
  // Row 0 of the branch is the roots; they start one row gap below the parent's bottom edge (above its top edge for up).
  const rowGap = COLUMN - WIDTH;
  const rootTop = Math.min(...roots.map(root => placed.get(root.id)!.y));
  const rootBottom = Math.max(...roots.map(root => placed.get(root.id)!.y + cardHeight(heightOf, root.id)));
  const shiftY =
    direction === "up" ? parent.y - rowGap - rootBottom : parent.y + cardHeight(heightOf, parent.id) + rowGap - rootTop;
  const fixed = nodes.filter(node => !newIds.has(node.id));
  for (;;) {
    let next = shiftX;
    for (const [id, point] of placed) {
      const own = cardHeight(heightOf, id);
      const topY = point.y + shiftY;
      for (const node of fixed) {
        const other = cardHeight(heightOf, node.id);
        const x = point.x + shiftX;
        if (
          x < node.x + WIDTH + LAYOUT_GAP &&
          node.x < x + WIDTH + LAYOUT_GAP &&
          topY < node.y + other + LAYOUT_GAP &&
          node.y < topY + own + LAYOUT_GAP
        )
          next = Math.max(next, node.x + WIDTH + LAYOUT_GAP - point.x);
      }
    }
    if (next === shiftX) break;
    shiftX = next;
  }
  return nodes.map(node => {
    const point = placed.get(node.id);
    return point ? { ...node, x: Math.round(point.x + shiftX), y: Math.round(point.y + shiftY) } : node;
  });
}

/** The side of the root a card's branch is on, from where the topic under the root stands now; undefined if unknown. */
function branchSide(byId: Map<string, MapNode>, node: MapNode): BalancedSide | undefined {
  let topic = node;
  while (topic.parentId && byId.get(topic.parentId)?.parentId) topic = byId.get(topic.parentId)!;
  const root = topic.parentId ? byId.get(topic.parentId) : undefined;
  return root ? sideFromOffset(topic.x - root.x) : undefined;
}

/**
 * A new branch in a balanced map. Under a sub-topic it follows that branch's side. New first-level topics go to the
 * shorter side (one at a time, so several new topics are dealt out between both sides); each side is then placed as a
 * right or left branch, with older cards staying where they are.
 */
function arrangeBalancedBranch(
  nodes: MapNode[],
  parent: MapNode,
  fresh: MapNode[],
  roots: MapNode[],
  newIds: Set<string>,
  heightOf: HeightOf | undefined,
  minTop: number | undefined,
  layout: LayoutKind | MapLayout
): MapNode[] {
  const { gap } = resolveLayout(layout);
  const spacing = typeof layout === "string" ? undefined : layout.spacing;
  const as = (direction: "right" | "left"): MapLayout => (spacing ? { direction, spacing } : { direction });
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (parent.parentId)
    return arrangeNewBranch(nodes, parent.id, newIds, heightOf, minTop, as(branchSide(byId, parent) ?? "right"));
  const older = nodes.filter(node => !newIds.has(node.id));
  const { kidsOf } = structureOf(older, true);
  const { sizes } = horizontalPositions({
    roots: [parent],
    kidsOf,
    joinsOf: () => [],
    heightFor: node => cardHeight(heightOf, node.id),
    column: 0,
    gap,
    sign: 1,
    left: 0,
    top: 0
  });
  const loads = { left: 0, right: 0 };
  for (const kid of kidsOf(parent)) {
    const side = sideFromOffset(kid.x - parent.x);
    if (side) loads[side] += sizes.get(kid.id)! + gap;
  }
  const { sizes: freshSizes } = horizontalPositions({
    roots,
    kidsOf: node => fresh.filter(item => item.parentId === node.id),
    joinsOf: () => [],
    heightFor: node => cardHeight(heightOf, node.id),
    column: 0,
    gap,
    sign: 1,
    left: 0,
    top: 0
  });
  const sides = greedySides(roots, root => freshSizes.get(root.id)!, gap, loads);
  const below = (id: string): string[] => [
    id,
    ...fresh.filter(item => item.parentId === id).flatMap(item => below(item.id))
  ];
  let current = nodes;
  const pending = new Set(newIds);
  for (const side of ["right", "left"] as const) {
    const mine = new Set(roots.filter(root => sides.get(root.id) === side).flatMap(root => below(root.id)));
    if (!mine.size) continue;
    for (const id of mine) pending.delete(id);
    const others = new Set(pending);
    const placed = arrangeNewBranch(
      current.filter(node => !others.has(node.id)),
      parent.id,
      mine,
      heightOf,
      minTop,
      as(side)
    );
    const moved = new Map(placed.map(node => [node.id, node]));
    current = current.map(node => moved.get(node.id) ?? node);
  }
  return current;
}

export function arrangeNewBranch(
  nodes: MapNode[],
  parentId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  /** The new branch's top edge starts at or below this y (before collision avoidance); undefined keeps the centred start. */
  minTop?: number,
  layout: LayoutKind | MapLayout = "right"
): MapNode[] {
  const { direction, column: COLUMN, gap: LAYOUT_GAP } = resolveLayout(layout);
  const parent = nodes.find(node => node.id === parentId);
  if (!parent || !newIds.size) return nodes;
  // Inside a branch with its own layout the new cards grow the way that branch does.
  const actual = layoutDirectionFor(nodes, parentId, direction);
  if (actual !== direction) {
    const spacing = typeof layout === "string" ? undefined : layout.spacing;
    const own = { direction: actual as LayoutKind, ...(spacing ? { spacing } : {}) };
    return arrangeNewBranch(nodes, parentId, newIds, heightOf, minTop, own);
  }
  const fresh = nodes.filter(node => newIds.has(node.id));
  const roots = fresh.filter(node => node.parentId === parentId);
  if (direction === "radial" || direction === "timeline" || direction === "fishbone")
    return rearrangeWhole(nodes, heightOf, layout);
  if (isVertical(direction)) return arrangeVerticalBranch(nodes, parent, fresh, roots, newIds, heightOf, layout);
  if (direction === "balanced")
    return arrangeBalancedBranch(nodes, parent, fresh, roots, newIds, heightOf, minTop, layout);
  const placed = positions(fresh, roots, parent.x + signOf(direction) * COLUMN, 0, false, heightOf, layout);
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
  layout: LayoutKind | MapLayout = "right"
): MapNode[] {
  const { direction, column: COLUMN, gap: LAYOUT_GAP } = resolveLayout(layout);
  const gap = LAYOUT_GAP;
  const root = nodes.find(node => node.id === rootId);
  if (!root || !newIds.has(rootId)) return nodes;
  const fixed = nodes.filter(node => !newIds.has(node.id));
  const fixedRoots = fixed.filter(node => !node.parentId);
  if (isVertical(direction)) {
    // A new top-level tree goes to the right of every existing card, on the root row.
    const anchors = fixedRoots.length ? fixedRoots : fixed;
    const x = fixed.length ? Math.max(...fixed.map(node => node.x)) + COLUMN : 80;
    const placed = positions(
      nodes.filter(node => newIds.has(node.id)),
      [root],
      x,
      0,
      false,
      heightOf,
      layout
    );
    const rootPoint = placed.get(rootId)!;
    const rowTop = anchors.length ? Math.min(...anchors.map(node => node.y)) : 80;
    const rowBottom = anchors.length
      ? Math.max(...anchors.map(node => node.y + cardHeight(heightOf, node.id)))
      : 80 + cardHeight(heightOf, rootId);
    const shiftY = direction === "up" ? rowBottom - (rootPoint.y + cardHeight(heightOf, rootId)) : rowTop - rootPoint.y;
    return nodes.map(node => {
      const point = placed.get(node.id);
      return point ? { ...node, x: Math.round(point.x), y: Math.round(point.y + shiftY) } : node;
    });
  }
  if (direction === "balanced") {
    // The new tree is dealt out between both sides from scratch and shares the root column of the older trees.
    const top = fixed.length ? Math.max(...fixed.map(node => node.y + cardHeight(heightOf, node.id))) + gap : 80;
    const placed = positions(
      nodes.filter(node => newIds.has(node.id)),
      [root],
      fixedRoots.length ? 0 : 80,
      top,
      false,
      heightOf,
      layout,
      true
    );
    const shiftX = fixedRoots.length ? Math.min(...fixedRoots.map(node => node.x)) - placed.get(rootId)!.x : 0;
    return nodes.map(node => {
      const point = placed.get(node.id);
      return point ? { ...node, x: point.x + shiftX, y: point.y } : node;
    });
  }
  const left = Math.min(...(fixedRoots.length ? fixedRoots : fixed).map(node => node.x), fixed.length ? Infinity : 80);
  const top = fixed.length ? Math.max(...fixed.map(node => node.y + cardHeight(heightOf, node.id))) + LAYOUT_GAP : 80;
  const placed = positions(
    nodes.filter(node => newIds.has(node.id)),
    [root],
    left,
    top,
    false,
    heightOf,
    layout
  );
  return nodes.map(node => {
    const point = placed.get(node.id);
    return point ? { ...node, x: point.x, y: Math.round(point.y) } : node;
  });
}

/**
 * Moves a first-level topic of `rootId` to the place `dropX` (the canvas x of the dragged card's centre) points at: it goes
 * in front of the first other topic whose centre is right of `dropX`, or last when there is none. Only the topics change
 * places with each other in the array; every other card keeps its index. An unknown id, a card that is not a first-level
 * topic of that root or a `dropX` that is not a finite number returns `nodes` itself.
 */
export function reorderTopLevel<T extends { id: string; parentId?: string | null; x: number }>(
  nodes: T[],
  rootId: string,
  movedId: string,
  dropX: number
): T[] {
  if (!Number.isFinite(dropX)) return nodes;
  const slots = nodes.flatMap((node, index) => (node.parentId === rootId ? [index] : []));
  const moved = slots.map(index => nodes[index]).find(node => node.id === movedId);
  if (!moved) return nodes;
  const others = slots.map(index => nodes[index]).filter(node => node !== moved);
  const at = others.findIndex(node => node.x + WIDTH / 2 > dropX);
  const order = at < 0 ? [...others, moved] : [...others.slice(0, at), moved, ...others.slice(at)];
  const result = nodes.slice();
  slots.forEach((index, place) => {
    result[index] = order[place];
  });
  return result;
}
