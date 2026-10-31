// Kept apart from map-layout.ts so the share viewer, which bundles map-layout.ts, does not pull in canvas items.
import { treeTextNodes, type CanvasItem, type TextItem } from "./experiences/visual-map/canvas-items";
import { arrangeMap, arrangeNewBranch, type HeightOf, type LayoutKind, type MapLayout } from "./map-layout";
import type { MapNode } from "./map-graph";

/** Text nodes that take part in a layout: their topic exists, is shown and is not collapsed. Others keep their coordinates. */
function visibleTexts(nodes: MapNode[], items: readonly CanvasItem[], hidden?: Set<string>): TextItem[] {
  const topics = new Map(nodes.map(node => [node.id, node]));
  return treeTextNodes(items, [...topics.keys()]).attached.filter(text => {
    const parent = topics.get(text.parentId as string);
    return parent !== undefined && !parent.collapsed && !hidden?.has(parent.id);
  });
}

const asLeaf = (text: TextItem): MapNode => ({
  id: text.id,
  path: "",
  parentId: text.parentId as string,
  x: text.x,
  y: text.y,
  collapsed: false
});

/** Writes the positions of the laid-out text leaves back into the item list; every other item stays the same object. */
function withTextPositions(items: readonly CanvasItem[], texts: TextItem[], placed: MapNode[]): CanvasItem[] {
  const at = new Map(placed.map(node => [node.id, node]));
  const mine = new Set(texts.map(text => text.id));
  return items.map(item => {
    const text = item as TextItem;
    const spot = text.kind === "text" && mine.has(text.id) ? at.get(text.id) : undefined;
    return spot ? { ...text, x: spot.x, y: spot.y } : item;
  });
}

/** `arrangeMap` with text nodes laid out as leaves under their topics. Without visible text nodes it is exactly `arrangeMap`. */
export function arrangeMapWithText(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  hidden?: Set<string>,
  heightOf?: HeightOf,
  layout: LayoutKind | MapLayout = "right",
  options: { reset?: boolean } = {}
): { nodes: MapNode[]; items: CanvasItem[] } {
  const texts = visibleTexts(nodes, items, hidden);
  if (!texts.length) return { nodes: arrangeMap(nodes, hidden, heightOf, layout, options), items: [...items] };
  const placed = arrangeMap([...nodes, ...texts.map(asLeaf)], hidden, heightOf, layout, options);
  const real = new Set(nodes.map(node => node.id));
  return {
    nodes: placed.filter(node => real.has(node.id)),
    items: withTextPositions(
      items,
      texts,
      placed.filter(node => !real.has(node.id))
    )
  };
}

/**
 * `arrangeNewBranch` with text nodes as leaves: those under a new card are placed with it, the others are fixed
 * obstacles the new cards slide around. Without visible text nodes it is exactly `arrangeNewBranch`.
 */
export function arrangeNewBranchWithText(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  parentId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  minTop?: number,
  layout: LayoutKind | MapLayout = "right"
): { nodes: MapNode[]; items: CanvasItem[] } {
  const texts = visibleTexts(nodes, items);
  if (!texts.length)
    return { nodes: arrangeNewBranch(nodes, parentId, newIds, heightOf, minTop, layout), items: [...items] };
  const withNew = new Set(newIds);
  for (const text of texts) if (newIds.has(text.parentId as string)) withNew.add(text.id);
  const placed = arrangeNewBranch([...nodes, ...texts.map(asLeaf)], parentId, withNew, heightOf, minTop, layout);
  const real = new Set(nodes.map(node => node.id));
  return {
    nodes: placed.filter(node => real.has(node.id)),
    items: withTextPositions(
      items,
      texts,
      placed.filter(node => !real.has(node.id))
    )
  };
}
