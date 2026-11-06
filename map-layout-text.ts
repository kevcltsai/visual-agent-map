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
  ringLine,
  ringImageSize,
  ringMembers,
  ringSide,
  ringViolations,
  solveRing,
  type Rect,
  type RingMember,
  type RingSide,
  type Segment
} from "./experiences/visual-map/image-ring";
import { allowsBranchLayout, branchDirectionOf, layoutDirectionFor } from "./layouts/compose";
import {
  arrangeMap,
  arrangeNewBranch,
  arrangeNewTree,
  DEFAULT_CARD_HEIGHT,
  type HeightOf,
  type LayoutKind,
  type MapLayout
} from "./map-layout";
import {
  CARD_WIDTH,
  childIndex,
  descendants,
  visibleNodes,
  walkDescendants,
  withTextParents,
  type MapNode
} from "./map-graph";

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

/**
 * The straight lines (as drawn) from the anchors of `group`'s picture, shown at `image`, to the topics that stay where they
 * are: the picture's non-ring relations whose topic is an ordinary shown card. A topic in the picture is drawn as a curve and is left out.
 */
function fixedLinesOf(
  group: RingGroup,
  image: Rect,
  nodes: readonly MapNode[],
  trees: ReadonlySet<string>,
  hidden: ReadonlySet<string> | undefined,
  heightOf: HeightOf | undefined
): Segment[] {
  const out: Segment[] = [];
  const shown = new Map(visibleNodes(nodes as MapNode[]).map(node => [node.id, node]));
  const anchors = new Map(group.image.anchors.map(anchor => [anchor.id, anchor]));
  for (const relation of group.image.relations ?? []) {
    if (relation.ring === true) continue;
    const anchor = anchors.get(relation.from) ?? anchors.get(relation.to);
    if (!anchor || anchor.at.kind !== "image-2d") continue;
    const topic = shown.get(anchor.id === relation.from ? relation.to : relation.from);
    if (!topic || trees.has(topic.id) || hidden?.has(topic.id)) continue;
    const box = nodeRect(topic, heightOf);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;
    if (cx > image.x && cx < image.x + image.w && cy > image.y && cy < image.y + image.h) continue;
    out.push(ringLine(image, anchor.at.x as number, anchor.at.y as number, box));
  }
  return out;
}

/**
 * Where the text blocks that hang directly on a ring card stand relative to it: the card's branch laid out on its own,
 * growing `direction`, as offsets from the card. Cards of the branch are not read from it (they are placed one after
 * another against the cards already there).
 */
function cardTextOffsets(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  rootId: string,
  direction: Outward,
  spacing: MapLayout["spacing"],
  heightOf: HeightOf | undefined,
  widthOf: TextWidthOf | undefined
): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>();
  if (!items.some(item => item.kind === "text" && (item as TextItem).parentId === rootId)) return out;
  const ids = new Set([rootId, ...descendants(nodes as MapNode[], rootId)]);
  const sub = nodes.filter(node => ids.has(node.id));
  const laid = arrangeMapWithText(
    sub,
    items,
    undefined,
    heightOf,
    { direction, ...(spacing ? { spacing } : {}) },
    { widthOf }
  );
  const root = laid.nodes.find(node => node.id === rootId)!;
  const shownIds = new Set(visibleNodes(sub).map(node => node.id));
  for (const text of visibleTexts(sub, items).filter(item => item.parentId === rootId && shownIds.has(rootId))) {
    const spot = laid.items.find(item => item.kind === "text" && (item as TextItem).id === text.id) as TextItem;
    out.set(text.id, { dx: spot.x - root.x, dy: spot.y - root.y });
  }
  return out;
}

/** The fixed lines of one picture's ring (see `fixedLinesOf`), for placing one more member without solving the ring again. */
export function ringFixedLines(
  nodes: readonly MapNode[],
  items: readonly CanvasItem[],
  imageId: string,
  heightOf: HeightOf | undefined,
  hidden?: ReadonlySet<string>
): Segment[] {
  const group = ringGroups(nodes, items).find(each => each.image.id === imageId);
  return group ? fixedLinesOf(group, imageRectOf(group.image), nodes, ringTreeIds(nodes, items), hidden, heightOf) : [];
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
  const textItems = items.filter((item): item is TextItem => item.kind === "text");
  for (const group of groups) {
    const base = options.enlarge ? ringImageSize(imageRectOf(group.image)) : imageRectOf(group.image);
    const inputs = group.members.map(member => {
      const rect = nodeRect(nodeAt(member.topicId), heightOf);
      return { id: member.topicId, anchorX: member.x, anchorY: member.y, w: rect.w, h: rect.h };
    });
    const memberIds = new Set(group.members.map(member => member.topicId));
    const below = new Map(group.members.map(member => [member.topicId, descendants(nodes, member.topicId)]));
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
    // The ring at one position of the picture: cards in their slots, then each branch laid out growing away from the picture.
    const place = (shift: { dx: number; dy: number }) => {
      const image: Rect = { ...base, x: base.x + shift.dx, y: base.y + shift.dy };
      const solved = solveRing(image, inputs, fixedLinesOf(group, image, nodes, trees, options.hidden, heightOf));
      const here = new Map<string, MapNode>();
      const hereTexts = new Map<string, { x: number; y: number }>();
      const textsNow = (): CanvasItem[] =>
        items.map(item =>
          item.kind === "text" && hereTexts.has((item as TextItem).id)
            ? { ...(item as TextItem), ...hereTexts.get((item as TextItem).id)! }
            : item
        );
      // Cards in their slots; what hangs below a card follows it rigidly first (a folded branch keeps that place).
      for (const card of solved.cards) {
        const old = nodeAt(card.id);
        const rootOff = { x: Math.round(card.x) - old.x, y: Math.round(card.y) - old.y };
        for (const id of new Set([card.id, ...below.get(card.id)!])) {
          const node = nodeAt(id);
          here.set(
            id,
            id === card.id
              ? { ...node, x: Math.round(card.x), y: Math.round(card.y) }
              : { ...node, x: node.x + rootOff.x, y: node.y + rootOff.y }
          );
        }
        const own = cardTextOffsets(nodes, items, card.id, OUTWARD[card.side], spacing, heightOf, widthOf);
        for (const text of textItems)
          if (text.parentId !== undefined && (text.parentId === card.id || below.get(card.id)!.has(text.parentId))) {
            const off = own.get(text.id);
            hereTexts.set(
              text.id,
              off
                ? { x: Math.round(card.x) + off.dx, y: Math.round(card.y) + off.dy }
                : { x: text.x + rootOff.x, y: text.y + rootOff.y }
            );
          }
      }
      // Branches one after another; the cards already placed are obstacles for the next.
      const done = new Set<string>();
      const footprint: Rect[] = [];
      for (const card of solved.cards) {
        const own: MapLayout = { direction: OUTWARD[card.side], ...(spacing ? { spacing } : {}) };
        const ids = below.get(card.id)!;
        // What a folded card hides is not laid out: it keeps its place against the card.
        const drawn = new Set(
          visibleNodes(nodes.filter(node => node.id === card.id || ids.has(node.id))).map(node => node.id)
        );
        const toPlace = new Set([...ids].filter(id => drawn.has(id)));
        const list = nodes
          .map(node => here.get(node.id) ?? nodeAt(node.id))
          .filter(
            node =>
              memberIds.has(node.id) ||
              done.has(node.id) ||
              ids.has(node.id) ||
              !(trees.has(node.id) && !movedNodes.has(node.id))
          );
        let placed: MapNode[] = list;
        if (toPlace.size) {
          const out = arrangeNewBranchWithText(list, textsNow(), card.id, toPlace, heightOf, undefined, own, widthOf);
          placed = out.nodes;
          for (const item of out.items)
            if (item.kind === "text" && hereTexts.has((item as TextItem).id))
              hereTexts.set((item as TextItem).id, { x: (item as TextItem).x, y: (item as TextItem).y });
        }
        const byId = new Map(placed.map(node => [node.id, node]));
        for (const id of toPlace) {
          const node = byId.get(id)!;
          here.set(id, { ...node, x: Math.round(node.x), y: Math.round(node.y) });
          done.add(id);
        }
        done.add(card.id);
      }
      const shown = visibleNodes(nodes.filter(node => here.has(node.id)));
      for (const node of shown) footprint.push(nodeRect(here.get(node.id)!, heightOf));
      const shownIds = new Set(shown.map(node => node.id));
      for (const text of textItems)
        if (hereTexts.has(text.id) && shownIds.has(text.parentId as string))
          footprint.push({ ...textRect(text, heightOf, widthOf), ...hereTexts.get(text.id)! });
      return { image, here, hereTexts, footprint };
    };
    // A shift of the ring changes the lines to the cards that stay, so the ring is solved again at the new place and
    // checked once more (at most a few times), instead of moving it afterwards.
    let shift = { dx: 0, dy: 0 };
    let result = place(shift);
    for (let pass = 0; pass < 3; pass++) {
      const free = findFreeOffset(ringBounds(result.image, result.footprint), obstacles);
      if (!free.dx && !free.dy) break;
      shift = { dx: shift.dx + free.dx, dy: shift.dy + free.dy };
      result = place(shift);
    }
    for (const [id, node] of result.here) movedNodes.set(id, node);
    for (const [id, spot] of result.hereTexts) movedTexts.set(id, spot);
    const finalImage = result.image;
    if (
      finalImage.x !== group.image.x ||
      finalImage.y !== group.image.y ||
      finalImage.w !== group.image.w ||
      finalImage.h !== group.image.h
    )
      movedImages.set(group.image.id, { ...group.image, ...finalImage });
    placedRects.push(finalImage, ...result.footprint);
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
