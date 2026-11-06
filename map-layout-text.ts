// Kept apart from map-layout.ts so the share viewer, which bundles map-layout.ts, does not pull in canvas items.
import {
  isAnnotatedImage,
  treeTextNodes,
  type AnnotatedImageItem,
  type CanvasItem,
  type TextItem
} from "./experiences/visual-map/canvas-items";
import {
  findFreeOffset,
  ringBounds,
  ringImageSize,
  ringMembers,
  ringSide,
  ringViolations,
  solveRing,
  type Rect,
  type RingMember,
  type RingSide
} from "./experiences/visual-map/image-ring";
import { allowsBranchLayout, branchDirectionOf, layoutDirectionFor } from "./layouts/compose";
import {
  arrangeMap,
  arrangeNewBranch,
  DEFAULT_CARD_HEIGHT,
  type HeightOf,
  type LayoutKind,
  type MapLayout
} from "./map-layout";
import { CARD_WIDTH, descendants, visibleNodes, type MapNode } from "./map-graph";

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

/** `arrangeMap` with text nodes laid out as leaves under their topics. Without visible text nodes it is exactly `arrangeMap`. */
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
  const placed = arrangeMap([...nodes, ...texts.map(asLeaf(options.widthOf))], hidden, heightOf, layout, options);
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
  layout: LayoutKind | MapLayout = "right",
  widthOf?: TextWidthOf
): { nodes: MapNode[]; items: CanvasItem[] } {
  const texts = visibleTexts(nodes, items);
  if (!texts.length)
    return { nodes: arrangeNewBranch(nodes, parentId, newIds, heightOf, minTop, layout), items: [...items] };
  const withNew = new Set(newIds);
  for (const text of texts) if (newIds.has(text.parentId as string)) withNew.add(text.id);
  const placed = arrangeNewBranch(
    [...nodes, ...texts.map(asLeaf(widthOf))],
    parentId,
    withNew,
    heightOf,
    minTop,
    layout
  );
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

// --- annotated images with a ring of topics ------------------------------------------------------------------------
// The ring (image-ring.ts) is kept out of every tree layout: its members and their branches are hidden from the
// engines, so they keep their coordinates, and are placed afterwards by `solveRings`. map-layout.ts knows nothing of it.

type Outward = "right" | "left" | "down" | "up";
const OUTWARD: Record<RingSide, Outward> = { top: "up", bottom: "down", left: "left", right: "right" };
/** The problems that mean a card really is in the way; `pairing` and `count` only say a hand-placed ring is not the tidiest one. */
const IN_THE_WAY = new Set(["overlap", "overlap-other", "line-through-card", "card-on-image", "crossing"]);
const TEXT_FALLBACK_WIDTH = 160;
const TEXT_FALLBACK_HEIGHT = 28;

interface RingGroup {
  image: AnnotatedImageItem;
  members: RingMember[];
}

/** The annotated images that have ring members, in item order. */
function ringGroups(nodes: readonly MapNode[], items: readonly CanvasItem[]): RingGroup[] {
  if (!items.some(item => isAnnotatedImage(item) && item.relations?.some(r => r.ring === true))) return [];
  const members = ringMembers(items, nodes);
  const groups = new Map<string, RingGroup>();
  for (const member of members) {
    const hit = groups.get(member.imageId);
    if (hit) hit.members.push(member);
    else {
      const image = items.find(item => isAnnotatedImage(item) && item.id === member.imageId) as AnnotatedImageItem;
      groups.set(member.imageId, { image, members: [member] });
    }
  }
  return [...groups.values()];
}

const nodeRect = (node: MapNode, heightOf?: HeightOf): Rect => ({
  x: node.x,
  y: node.y,
  w: node.width ?? CARD_WIDTH,
  h: heightOf?.(node.id) ?? node.height ?? DEFAULT_CARD_HEIGHT
});
const imageRectOf = (image: AnnotatedImageItem): Rect => ({ x: image.x, y: image.y, w: image.w, h: image.h });

/** Ring members and every topic below them. */
export function ringTreeIds(nodes: readonly MapNode[], items: readonly CanvasItem[]): Set<string> {
  const out = new Set<string>();
  for (const group of ringGroups(nodes, items))
    for (const member of group.members) {
      out.add(member.topicId);
      for (const id of descendants(nodes as MapNode[], member.topicId)) out.add(id);
    }
  return out;
}

/** Ring members only (the topics that sit around a picture). */
export function ringMemberIds(nodes: readonly MapNode[], items: readonly CanvasItem[]): Set<string> {
  return new Set(ringGroups(nodes, items).flatMap(group => group.members.map(member => member.topicId)));
}

/** For each ring member, the way its branch grows: away from the picture. Derived from where the card stands, never stored. */
export function ringOutwardDirections(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  heightOf?: HeightOf
): Map<string, Outward> {
  const out = new Map<string, Outward>();
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const group of ringGroups(nodes, items))
    for (const member of group.members) {
      const node = byId.get(member.topicId);
      if (node) out.set(member.topicId, OUTWARD[ringSide(imageRectOf(group.image), nodeRect(node, heightOf))]);
    }
  return out;
}

/**
 * `layoutDirectionFor` with ring members growing outward: the nearest ring member (or a branch with its own layout) above
 * `id` decides. Without ring members it is `layoutDirectionFor`.
 */
export function directionWithRings(
  nodes: readonly MapNode[],
  rings: ReadonlyMap<string, string>,
  id: string,
  mapDirection: string
): string {
  if (!rings.size) return layoutDirectionFor(nodes as MapNode[], id, mapDirection);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const layered = allowsBranchLayout(mapDirection);
  let current = byId.get(id);
  for (let guard = 0; current && guard < 10000; guard++) {
    const ring = rings.get(current.id);
    if (ring) return ring;
    const own = layered ? branchDirectionOf(current) : undefined;
    if (own) return own;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return mapDirection;
}

const textRect = (item: TextItem, heightOf?: HeightOf, widthOf?: TextWidthOf): Rect => ({
  x: item.x,
  y: item.y,
  w: widthOf?.(item.id) ?? item.width ?? TEXT_FALLBACK_WIDTH,
  h: heightOf?.(item.id) ?? TEXT_FALLBACK_HEIGHT
});

/** What a ring may not cover: shown cards and their texts outside every ring, free texts, other pictures, and rings already placed. */
function obstacleRects(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  selfImageId: string,
  trees: ReadonlySet<string>,
  heightOf: HeightOf | undefined,
  widthOf: TextWidthOf | undefined,
  hidden: ReadonlySet<string> | undefined,
  placed: readonly Rect[]
): Rect[] {
  const shown = visibleNodes(nodes as MapNode[]).filter(node => !trees.has(node.id) && !hidden?.has(node.id));
  const shownIds = new Set(shown.map(node => node.id));
  const known = new Set(nodes.map(node => node.id));
  const out: Rect[] = shown.map(node => nodeRect(node, heightOf));
  for (const item of items) {
    if (item.kind === "text") {
      const text = item as TextItem;
      const parent = text.parentId;
      if (parent !== undefined && known.has(parent) && !shownIds.has(parent)) continue;
      out.push(textRect(text, heightOf, widthOf));
    } else if ((item.kind === "image" || isAnnotatedImage(item)) && (item as { id: string }).id !== selfImageId) {
      const { x, y, w, h } = item as unknown as Rect;
      if ([x, y, w, h].every(Number.isFinite)) out.push({ x, y, w, h });
    }
  }
  return [...out, ...placed];
}

interface SubtreeLayout {
  /** Where each shown card and text of the branch sits relative to the branch's top card. */
  cards: Map<string, { dx: number; dy: number }>;
  texts: Map<string, { dx: number; dy: number }>;
}

/** The branch of one ring member laid out on its own, growing `direction`, as offsets from its top card. */
function layoutSubtree(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  rootId: string,
  direction: Outward,
  spacing: MapLayout["spacing"],
  heightOf: HeightOf | undefined,
  widthOf: TextWidthOf | undefined
): SubtreeLayout {
  const ids = new Set([rootId, ...descendants(nodes as MapNode[], rootId)]);
  const sub = nodes.filter(node => ids.has(node.id));
  const layout: MapLayout = { direction, ...(spacing ? { spacing } : {}) };
  const out = arrangeMapWithText(sub, items, undefined, heightOf, layout, { widthOf });
  const at = new Map(out.nodes.map(node => [node.id, node]));
  const root = at.get(rootId)!;
  const cards = new Map<string, { dx: number; dy: number }>();
  const shown = visibleNodes(sub);
  for (const node of shown) {
    const spot = at.get(node.id)!;
    cards.set(node.id, { dx: spot.x - root.x, dy: spot.y - root.y });
  }
  const texts = new Map<string, { dx: number; dy: number }>();
  const shownIds = new Set(shown.map(node => node.id));
  // A text under a card inside a folded branch is not drawn by the layout, so it keeps its place and follows its card.
  for (const text of visibleTexts(sub, items).filter(item => shownIds.has(item.parentId as string))) {
    const spot = out.items.find(item => (item as TextItem).id === text.id && item.kind === "text") as TextItem;
    texts.set(text.id, { dx: spot.x - root.x, dy: spot.y - root.y });
  }
  return { cards, texts };
}

export interface RingSolveOptions {
  /** Only these pictures' rings are solved again; absent means all. */
  imageIds?: ReadonlySet<string>;
  /** Grow a small picture to the ring size first (the first time it becomes a ring centre). */
  enlarge?: boolean;
  /** Cards that are not drawn (they are not obstacles). */
  hidden?: ReadonlySet<string>;
}

/**
 * Places every ring again: the picture grows if asked, the cards go to their slots, each branch is laid out growing
 * away from the picture and follows its card. A ring that would cover another card, text or picture moves, picture and
 * all, to the nearest free place; nothing else moves. Without rings it changes nothing.
 */
export function solveRings(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  heightOf: HeightOf | undefined,
  widthOf: TextWidthOf | undefined,
  layout: LayoutKind | MapLayout,
  options: RingSolveOptions = {}
): { nodes: MapNode[]; items: CanvasItem[] } {
  const groups = ringGroups(nodes, items).filter(group => !options.imageIds || options.imageIds.has(group.image.id));
  if (!groups.length) return { nodes, items: [...items] };
  const spacing = typeof layout === "string" ? undefined : layout.spacing;
  const trees = ringTreeIds(nodes, items);
  const placedRects: Rect[] = [];
  const movedNodes = new Map<string, MapNode>();
  const movedTexts = new Map<string, { x: number; y: number }>();
  const movedImages = new Map<string, AnnotatedImageItem>();
  const nodeAt = (id: string): MapNode => movedNodes.get(id) ?? nodes.find(node => node.id === id)!;
  for (const group of groups) {
    const image = options.enlarge ? ringImageSize(imageRectOf(group.image)) : imageRectOf(group.image);
    const inputs = group.members.map(member => {
      const rect = nodeRect(nodeAt(member.topicId), heightOf);
      return { id: member.topicId, anchorX: member.x, anchorY: member.y, w: rect.w, h: rect.h };
    });
    const solved = solveRing(image, inputs);
    const subtrees = solved.cards.map(card =>
      layoutSubtree(nodes, items, card.id, OUTWARD[ringSide(image, card)], spacing, heightOf, widthOf)
    );
    // The footprint: the picture, the cards and everything grown from them.
    const footprint: Rect[] = [];
    solved.cards.forEach((card, i) => {
      for (const [id, off] of subtrees[i].cards)
        footprint.push({ ...nodeRect(nodeAt(id), heightOf), x: card.x + off.dx, y: card.y + off.dy });
      for (const [id, off] of subtrees[i].texts) {
        const text = items.find(item => item.kind === "text" && (item as TextItem).id === id) as TextItem;
        footprint.push({ ...textRect(text, heightOf, widthOf), x: card.x + off.dx, y: card.y + off.dy });
      }
    });
    const obstacles = obstacleRects(
      nodes,
      items,
      group.image.id,
      trees,
      heightOf,
      widthOf,
      options.hidden,
      placedRects
    );
    const { dx, dy } = findFreeOffset(ringBounds(image, footprint), obstacles);
    // Apply: shifted picture, cards and branches. What the branch layout did not draw (folded branches) follows its card.
    solved.cards.forEach((card, i) => {
      const old = nodeAt(card.id);
      const tx = Math.round(card.x + dx);
      const ty = Math.round(card.y + dy);
      const sub = subtrees[i];
      const rootOff = { x: tx - old.x, y: ty - old.y };
      for (const id of new Set([card.id, ...descendants(nodes, card.id)])) {
        const node = nodeAt(id);
        const off = sub.cards.get(id);
        movedNodes.set(
          id,
          off ? { ...node, x: tx + off.dx, y: ty + off.dy } : { ...node, x: node.x + rootOff.x, y: node.y + rootOff.y }
        );
      }
      for (const item of items) {
        if (item.kind !== "text") continue;
        const text = item as TextItem;
        const below =
          text.parentId !== undefined && (text.parentId === card.id || descendants(nodes, card.id).has(text.parentId));
        if (!below) continue;
        const off = sub.texts.get(text.id);
        movedTexts.set(
          text.id,
          off ? { x: tx + off.dx, y: ty + off.dy } : { x: text.x + rootOff.x, y: text.y + rootOff.y }
        );
      }
    });
    const finalImage: Rect = { ...image, x: image.x + dx, y: image.y + dy };
    if (
      finalImage.x !== group.image.x ||
      finalImage.y !== group.image.y ||
      finalImage.w !== group.image.w ||
      finalImage.h !== group.image.h
    )
      movedImages.set(group.image.id, { ...group.image, ...finalImage });
    placedRects.push(finalImage);
    for (const rect of footprint) placedRects.push({ ...rect, x: rect.x + dx, y: rect.y + dy });
  }
  return {
    nodes: nodes.map(node => movedNodes.get(node.id) ?? node),
    items: items.map(item => {
      if (item.kind === "text") {
        const spot = movedTexts.get((item as TextItem).id);
        return spot ? { ...(item as TextItem), x: Math.round(spot.x), y: Math.round(spot.y) } : item;
      }
      return movedImages.get((item as { id: string }).id) ?? item;
    })
  };
}

/** `arrangeMapWithText`, except that ring members and their branches stay out of the arrangement and the rings are solved after it. Without rings it is exactly `arrangeMapWithText`. */
export function arrangeMapWithRings(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  hidden: Set<string> | undefined,
  heightOf: HeightOf | undefined,
  layout: LayoutKind | MapLayout,
  options: { reset?: boolean; widthOf?: TextWidthOf } = {}
): { nodes: MapNode[]; items: CanvasItem[] } {
  const trees = ringTreeIds(nodes, items);
  if (!trees.size) return arrangeMapWithText(nodes, items, hidden, heightOf, layout, options);
  const skipped = new Set([...(hidden ?? []), ...trees]);
  const rest = nodes.every(node => skipped.has(node.id))
    ? { nodes, items: [...items] }
    : arrangeMapWithText(nodes, items, skipped, heightOf, layout, options);
  return solveRings(rest.nodes, rest.items, heightOf, options.widthOf, layout, { hidden });
}

/**
 * `arrangeNewBranchWithText` that never rearranges a ring. Under a ring member the branch grows away from the picture;
 * in a map that is laid out whole again for a new branch (radial, timeline, fishbone) the rings are taken out first; in the
 * others they stay as obstacles. Without rings it is exactly `arrangeNewBranchWithText`.
 */
export function arrangeNewBranchWithRings(
  nodes: MapNode[],
  items: readonly CanvasItem[],
  parentId: string,
  newIds: Set<string>,
  heightOf?: HeightOf,
  minTop?: number,
  layout: LayoutKind | MapLayout = "right",
  widthOf?: TextWidthOf
): { nodes: MapNode[]; items: CanvasItem[] } {
  const trees = ringTreeIds(nodes, items);
  if (!trees.size) return arrangeNewBranchWithText(nodes, items, parentId, newIds, heightOf, minTop, layout, widthOf);
  if (trees.has(parentId)) {
    let top = nodes.find(node => node.id === parentId);
    while (top?.parentId) top = nodes.find(node => node.id === top!.parentId);
    const direction = top && ringOutwardDirections(nodes, items, heightOf).get(top.id);
    const spacing = typeof layout === "string" ? undefined : layout.spacing;
    const own: MapLayout = { direction: direction ?? "right", ...(spacing ? { spacing } : {}) };
    return arrangeNewBranchWithText(nodes, items, parentId, newIds, heightOf, minTop, own, widthOf);
  }
  const kind = typeof layout === "string" ? layout : layout.direction;
  if (kind !== "radial" && kind !== "timeline" && kind !== "fishbone")
    return arrangeNewBranchWithText(nodes, items, parentId, newIds, heightOf, minTop, layout, widthOf);
  const rest = nodes.filter(node => !trees.has(node.id));
  const out = arrangeNewBranchWithText(rest, items, parentId, newIds, heightOf, minTop, layout, widthOf);
  const placed = new Map(out.nodes.map(node => [node.id, node]));
  return { nodes: nodes.map(node => placed.get(node.id) ?? node), items: out.items };
}

/** The pictures whose ring has a card in the way after cards grew (`cards`) or a picture was resized (`images`). A hand-placed card that is merely not the tidiest pairing is left where it is. */
export function ringImagesInTheWay(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  heightOf: HeightOf | undefined,
  widthOf: TextWidthOf | undefined,
  touched: { cards?: ReadonlySet<string>; images?: ReadonlySet<string> },
  hidden?: ReadonlySet<string>
): Set<string> {
  const out = new Set<string>();
  const groups = ringGroups(nodes, items);
  if (!groups.length) return out;
  const trees = ringTreeIds(nodes, items);
  const byId = new Map(nodes.map(node => [node.id, node]));
  for (const group of groups) {
    const cards = group.members.map(member => ({
      id: member.topicId,
      ...nodeRect(byId.get(member.topicId)!, heightOf),
      anchorX: member.x,
      anchorY: member.y
    }));
    const others = obstacleRects(nodes, items, group.image.id, trees, heightOf, widthOf, hidden, []);
    const wholeImage = touched.images?.has(group.image.id) === true;
    const bad = ringViolations(imageRectOf(group.image), cards, { others }).filter(
      v => IN_THE_WAY.has(v.code) && (wholeImage || v.ids.some(id => touched.cards?.has(id)))
    );
    if (bad.length) out.add(group.image.id);
  }
  return out;
}
