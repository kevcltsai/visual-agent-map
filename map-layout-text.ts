// Kept apart from map-layout.ts so the share viewer, which bundles map-layout.ts, does not pull in canvas items.
import { treeTextNodes, type CanvasItem, type TextItem } from "./experiences/visual-map/canvas-items";
import {
  arrangeMap,
  arrangeNewBranch,
  arrangeNewTree,
  type HeightOf,
  type LayoutKind,
  type MapLayout
} from "./map-layout";
import { childIndex, walkDescendants, withTextParents, type MapNode } from "./map-graph";

/** Text nodes that take part in a layout: their topic exists, is shown and is not collapsed. Others keep their coordinates. */
function visibleTexts(nodes: MapNode[], items: readonly CanvasItem[], hidden?: Set<string>): TextItem[] {
  const topics = new Map(nodes.map(node => [node.id, node]));
  return treeTextNodes(items, [...topics.keys()]).attached.filter(text => {
    const parent = topics.get(text.parentId as string);
    return parent !== undefined && !parent.collapsed && !hidden?.has(parent.id);
  });
}

/** The width a text block really has (drawn width, else its stored width); undefined while unknown, which lays it out as a card. */
export type TextWidthOf = (id: string) => number | undefined;

/** A text block is a leaf as wide as it is drawn: the layout aligns it to the topic and keeps its neighbours clear of it. */
const asLeaf =
  (widthOf?: TextWidthOf) =>
  (text: TextItem): MapNode => {
    const width = widthOf?.(text.id) ?? text.width;
    return {
      id: text.id,
      path: "",
      parentId: text.parentId as string,
      x: text.x,
      y: text.y,
      collapsed: false,
      ...(width !== undefined ? { width } : {})
    };
  };

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

/**
 * The tree the layout works on: every text block is a node under its topic, and a topic that follows a text block hangs under
 * that block (so a block with followers is an intermediate node, not a leaf). Only for layout; its `parentId`s are not the saved ones.
 */
function virtualTree(nodes: MapNode[], texts: TextItem[], widthOf?: TextWidthOf): MapNode[] {
  const parents = new Map(texts.map(text => [text.id, text.parentId as string]));
  return [...withTextParents(nodes, parents), ...texts.map(asLeaf(widthOf))];
}

/**
 * Takes only x and y of the laid-out virtual tree back onto the real nodes. A virtual `parentId` (a text id) that got out into
 * a saved map would make `parseMap` throw and the whole map unopenable, so nothing else is ever copied.
 */
function mergePositions(nodes: MapNode[], placed: MapNode[]): MapNode[] {
  const at = new Map(placed.map(node => [node.id, node]));
  return nodes.map(node => {
    const spot = at.get(node.id);
    return spot ? { ...node, x: spot.x, y: spot.y } : node;
  });
}

/** `arrangeMap` with text nodes laid out under their topics (as leaves, or as the parent of the topics that follow them). Without visible text nodes it is exactly `arrangeMap`. */
export function arrangeMapWithText(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  hidden?: Set<string>,
  heightOf?: HeightOf,
  layout: LayoutKind | MapLayout = "right",
  options: { reset?: boolean; widthOf?: TextWidthOf } = {}
): { nodes: MapNode[]; items: CanvasItem[] } {
  const texts = visibleTexts(nodes, items, hidden);
  if (!texts.length) return { nodes: arrangeMap(nodes, hidden, heightOf, layout, options), items: [...items] };
  const placed = arrangeMap(virtualTree(nodes, texts, options.widthOf), hidden, heightOf, layout, options);
  const real = new Set(nodes.map(node => node.id));
  return {
    nodes: mergePositions(nodes, placed),
    items: withTextPositions(
      items,
      texts,
      placed.filter(node => !real.has(node.id))
    )
  };
}

/**
 * `arrangeNewBranch` with text nodes in the tree: those under a new card are placed with it, the others are fixed
 * obstacles the new cards slide around. A new topic that follows a text block brings the block (and what hangs after it) into
 * the placement, so it lands after the block. Without visible text nodes it is exactly `arrangeNewBranch`.
 */
export function arrangeNewBranchWithText(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  parentId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  minTop?: number,
  layout: LayoutKind | MapLayout = "right",
  widthOf?: TextWidthOf
): { nodes: MapNode[]; items: CanvasItem[] } {
  const texts = visibleTexts(nodes, items);
  if (!texts.length)
    return { nodes: arrangeNewBranch(nodes, parentId, newIds, heightOf, minTop, layout), items: [...items] };
  const virtual = virtualTree(nodes, texts, widthOf);
  const textIds = new Set(texts.map(text => text.id));
  const withNew = new Set(newIds);
  const brought = new Set<string>();
  for (const text of texts) if (newIds.has(text.parentId as string)) withNew.add(text.id);
  // A new follower is only placed after its block when the block takes part: unless the block is the parent being grown from.
  for (const node of virtual)
    if (newIds.has(node.id) && textIds.has(node.parentId as string) && node.parentId !== parentId) {
      withNew.add(node.parentId as string);
      brought.add(node.parentId as string);
    }
  if (brought.size) {
    const index = childIndex(virtual);
    const below = new Set<string>();
    for (const id of brought) walkDescendants(index, id, below);
    for (const id of below) withNew.add(id);
  }
  const placed = arrangeNewBranch(virtual, parentId, withNew, heightOf, minTop, layout);
  const real = new Set(nodes.map(node => node.id));
  return {
    nodes: mergePositions(nodes, placed),
    items: withTextPositions(
      items,
      texts,
      placed.filter(node => !real.has(node.id))
    )
  };
}

/**
 * `arrangeNewTree` for a branch that became a top-level tree. A text block hanging on a topic of the branch that has topics
 * following it goes with the branch (it is laid out as the node between its topic and its followers, as Auto layout does);
 * every other text block stays where it is. Without such a block it is exactly `arrangeNewTree`. Never lays the whole map out again.
 */
export function arrangeNewTreeWithText(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  rootId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  layout: LayoutKind | MapLayout = "right",
  widthOf?: TextWidthOf
): { nodes: MapNode[]; items: CanvasItem[] } {
  const followed = new Set(nodes.flatMap(node => (node.afterTextId ? [node.afterTextId] : [])));
  const texts = visibleTexts(nodes, items).filter(text => newIds.has(text.parentId as string) && followed.has(text.id));
  if (!texts.length) return { nodes: arrangeNewTree(nodes, rootId, newIds, heightOf, layout), items: [...items] };
  const withNew = new Set([...newIds, ...texts.map(text => text.id)]);
  const placed = arrangeNewTree(virtualTree(nodes, texts, widthOf), rootId, withNew, heightOf, layout);
  const real = new Set(nodes.map(node => node.id));
  return {
    nodes: mergePositions(nodes, placed),
    items: withTextPositions(
      items,
      texts,
      placed.filter(node => !real.has(node.id))
    )
  };
}
