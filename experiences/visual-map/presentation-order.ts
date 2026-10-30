/**
 * Presentation reading order of a map: a pre-order walk of the parentId tree, siblings sorted by position.
 * Pure functions, no DOM. Collapsed branches are skipped by default so a presentation follows what is on screen.
 */
import type { MapNode } from "../../map-graph";

export interface ReadingOrderOptions {
  /** Primary sibling axis: "y" for right/left reading (default), "x" for down/up. */
  siblingAxis?: "y" | "x";
  /** List the descendants of collapsed nodes too (default false). */
  includeHidden?: boolean;
}

export interface OrderStep {
  id: string;
  index: number;
  total: number;
}

/** Ids in presentation order. Iterative; ignores aimConvergesFromNodeIds; each id appears once. */
export function readingOrder(nodes: readonly MapNode[], opts: ReadingOrderOptions = {}): string[] {
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
