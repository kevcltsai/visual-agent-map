/**
 * Presentation reading order of a map: a pre-order walk of the parentId tree, siblings sorted by position.
 * Pure functions, no DOM. Collapsed branches are skipped by default so a presentation follows what is on screen.
 */
import { withTextParents, type MapNode } from "../../map-graph";

export interface ReadingOrderOptions {
  /** Primary sibling axis: "y" for right/left reading (default), "x" for down/up. */
  siblingAxis?: "y" | "x";
  /** List the descendants of collapsed nodes too (default false). */
  includeHidden?: boolean;
  /** Text nodes hung on topics (`treeTextNodes(...).attached`); each reads as a leaf among its parent's children. */
  textNodes?: readonly { id: string; parentId: string; x: number; y: number }[];
}

export interface OrderStep {
  id: string;
  index: number;
  total: number;
}

/** Ids in presentation order. Iterative; ignores aimConvergesFromNodeIds; each id appears once. */
export function readingOrder(topics: readonly MapNode[], opts: ReadingOrderOptions = {}): string[] {
  let nodes = topics;
  if (opts.textNodes?.length) {
    const known = new Set(topics.map(node => node.id));
    const leaves: MapNode[] = [];
    for (const text of opts.textNodes) {
      if (known.has(text.id) || !known.has(text.parentId)) continue;
      known.add(text.id);
      leaves.push({ id: text.id, path: "", parentId: text.parentId, x: text.x, y: text.y, collapsed: false });
    }
    // A topic that follows a text reads after it, among the text's children.
    nodes = withTextParents([...topics, ...leaves], new Map(leaves.map(leaf => [leaf.id, leaf.parentId as string])));
  }
  const axis = opts.siblingAxis ?? "y";
  const other = axis === "y" ? "x" : "y";
  const includeHidden = opts.includeHidden === true;
  const position = new Map<string, number>();
  nodes.forEach((node, index) => {
    if (!position.has(node.id)) position.set(node.id, index);
  });
  const byPosition = (a: MapNode, b: MapNode): number =>
    a[axis] - b[axis] || a[other] - b[other] || (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0);
  const roots: MapNode[] = [];
  const children = new Map<string, MapNode[]>();
  const seenInput = new Set<string>();
  for (const node of nodes) {
    if (seenInput.has(node.id)) continue;
    seenInput.add(node.id);
    if (node.parentId === null || !position.has(node.parentId)) {
      roots.push(node);
      continue;
    }
    const list = children.get(node.parentId);
    if (list) list.push(node);
    else children.set(node.parentId, [node]);
  }
  const sortedRoots = [...roots].sort(byPosition);
  const sortedKids = new Map<string, MapNode[]>();
  for (const [id, list] of children) sortedKids.set(id, [...list].sort(byPosition));
  const walk = (withHidden: boolean): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const stack: MapNode[] = [...sortedRoots].reverse();
    while (stack.length) {
      const node = stack.pop() as MapNode;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push(node.id);
      if (node.collapsed && !withHidden) continue;
      const kids = sortedKids.get(node.id);
      if (kids) for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    return out;
  };
  const order = walk(includeHidden);
  // Nodes a parent cycle cuts off from every root: appended last in the same sibling order, once each.
  const reachable = includeHidden ? new Set(order) : new Set(walk(true));
  const cut = nodes.filter((node, index) => position.get(node.id) === index && !reachable.has(node.id));
  for (const node of cut.sort(byPosition)) order.push(node.id);
  return order;
}

/** One step through `order` without wrapping. Unknown or null current: first (delta 1) or last (delta -1). */
export function stepOrder(order: string[], currentId: string | null, delta: 1 | -1): OrderStep | null {
  const total = order.length;
  if (total === 0) return null;
  const at = currentId === null ? -1 : order.indexOf(currentId);
  const index = at < 0 ? (delta === 1 ? 0 : total - 1) : at + delta;
  if (index < 0 || index >= total) return null;
  return { id: order[index], index, total };
}

/** Sibling comparator along an axis: "y" for right/left maps, "x" for down/up maps (the order the keyboard walk and the reading order use). */
export const bySiblingAxis =
  (axis: "x" | "y") =>
  (a: { x: number; y: number }, b: { x: number; y: number }): number =>
    axis === "y" ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y;

/**
 * `nodes` with the children of every parent put in on-screen order: they take the slots the children had in the array, sorted
 * along the sibling axis `axisOf` names for that parent (null keeps the array order there, e.g. a timeline's first level, a
 * balanced or radial root). Every other card keeps its index; ties keep array order. Returns `nodes` itself when nothing moves.
 */
export function alignSiblingsToScreen<T extends { id: string; parentId: string | null; x: number; y: number }>(
  nodes: readonly T[],
  axisOf: (parentId: string | null, firstChildId: string) => "x" | "y" | null
): T[] {
  const slots = new Map<string | null, number[]>();
  nodes.forEach((node, index) => {
    const list = slots.get(node.parentId);
    if (list) list.push(index);
    else slots.set(node.parentId, [index]);
  });
  const result = nodes.slice();
  let moved = false;
  for (const [parentId, list] of slots) {
    if (list.length < 2) continue;
    const axis = axisOf(parentId, nodes[list[0]].id);
    if (!axis) continue;
    const order = list.map(index => nodes[index]).sort(bySiblingAxis(axis));
    list.forEach((index, place) => {
      if (result[index] !== order[place]) moved = true;
      result[index] = order[place];
    });
  }
  return moved ? result : (nodes as T[]);
}
